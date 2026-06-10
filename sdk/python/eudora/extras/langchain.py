"""LangChain callbacks for Eudora compliance ingestion."""

import logging
import threading
import time
from typing import Any, Dict, List, Optional

import httpx

try:
    from langchain_core.callbacks import BaseCallbackHandler
except ImportError:
    class BaseCallbackHandler:  # type: ignore
        """Fallback base used when the optional LangChain extra is absent."""


LOGGER = logging.getLogger(__name__)


def _run_key(run_id: Any) -> str:
    return str(run_id) if run_id is not None else "default"


def _name(serialized: Optional[Dict[str, Any]]) -> Optional[str]:
    if not serialized:
        return None
    if serialized.get("name"):
        return str(serialized["name"])
    identifier = serialized.get("id")
    if isinstance(identifier, list) and identifier:
        return str(identifier[-1])
    return str(identifier) if identifier else None


def _text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    content = getattr(value, "content", None)
    if content is not None:
        return _text(content)
    if isinstance(value, list):
        return "\n".join(_text(item) for item in value)
    return str(value)


def _json_value(value: Any) -> Any:
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, dict):
        return {str(key): _json_value(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_value(item) for item in value]
    return _text(value)


def _response_text(response: Any) -> str:
    texts = []
    for generation_group in getattr(response, "generations", None) or []:
        group = generation_group if isinstance(generation_group, list) else [generation_group]
        for generation in group:
            value = getattr(generation, "text", None)
            if value is None:
                value = getattr(generation, "message", None)
            if value is not None:
                texts.append(_text(value))
    return "\n".join(value for value in texts if value)


def _token_usage(response: Any) -> Dict[str, int]:
    llm_output = getattr(response, "llm_output", None) or {}
    usage = llm_output.get("token_usage") or llm_output.get("usage") or {}
    if not usage:
        for generation_group in getattr(response, "generations", None) or []:
            group = generation_group if isinstance(generation_group, list) else [generation_group]
            for generation in group:
                message = getattr(generation, "message", None)
                usage = getattr(message, "usage_metadata", None) or {}
                if usage:
                    break
            if usage:
                break
    return {
        "prompt_tokens": int(usage.get("prompt_tokens", usage.get("input_tokens", 0)) or 0),
        "completion_tokens": int(
            usage.get("completion_tokens", usage.get("output_tokens", 0)) or 0
        ),
    }


class EudoraCallbackHandler(BaseCallbackHandler):
    """Record LangChain LLM, chain, and tool activity without raising."""

    def __init__(
        self,
        proxy_key: str,
        agent_id: str,
        eudora_base_url: str = "https://api.geteudora.com",
    ) -> None:
        self.proxy_key = proxy_key
        self.agent_id = agent_id
        self.eudora_base_url = eudora_base_url.rstrip("/")
        self._llm_runs: Dict[str, Dict[str, Any]] = {}
        self._chains: Dict[str, Dict[str, Any]] = {}
        self._tools: Dict[str, Dict[str, Any]] = {}
        self._lock = threading.RLock()

    @property
    def _ingest_url(self) -> str:
        return "%s/v1/ingest" % self.eudora_base_url

    def _chain(self, parent_run_id: Any = None) -> Dict[str, Any]:
        with self._lock:
            if parent_run_id is not None:
                chain = self._chains.get(_run_key(parent_run_id))
                if chain:
                    return dict(chain)
            if self._chains:
                return dict(next(reversed(self._chains.values())))
        return {}

    def _tool_records(self) -> List[Dict[str, Any]]:
        with self._lock:
            return [dict(tool) for tool in self._tools.values()]

    def _payload(
        self,
        run: Dict[str, Any],
        response: str,
        token_usage: Optional[Dict[str, int]] = None,
        error: Optional[str] = None,
    ) -> Dict[str, Any]:
        chain = self._chain(run.get("chain_run_id"))
        metadata = {
            "chain_name": run.get("chain_name") or chain.get("name"),
            "chain_inputs": _json_value(chain.get("inputs")),
            "chain_outputs": _json_value(chain.get("outputs")),
            "tools_used": _json_value(self._tool_records()),
        }
        if error is not None:
            metadata.update({"status": "failed", "error": error})
        return {
            "agent_id": self.agent_id,
            "proxy_key": self.proxy_key,
            "source": "langchain",
            "prompt": run.get("prompt", ""),
            "response": response,
            "model": _json_value(run.get("model")),
            "latency_ms": max(0, int((time.time() - run["started_at"]) * 1000)),
            "token_usage": token_usage
            or {"prompt_tokens": 0, "completion_tokens": 0},
            "metadata": metadata,
        }

    def _post(self, payload: Dict[str, Any]) -> None:
        try:
            with httpx.Client(timeout=5.0) as client:
                response = client.post(self._ingest_url, json=payload)
                response.raise_for_status()
        except Exception as exc:
            LOGGER.warning("Eudora LangChain ingest failed: %s", exc)

    async def _apost(self, payload: Dict[str, Any]) -> None:
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                response = await client.post(self._ingest_url, json=payload)
                response.raise_for_status()
        except Exception as exc:
            LOGGER.warning("Eudora LangChain ingest failed: %s", exc)

    def _start_llm(
        self,
        serialized: Optional[Dict[str, Any]],
        prompts: List[str],
        run_id: Any,
        parent_run_id: Any,
        kwargs: Dict[str, Any],
    ) -> None:
        invocation = kwargs.get("invocation_params") or {}
        model = (
            invocation.get("model")
            or invocation.get("model_name")
            or kwargs.get("model")
            or kwargs.get("model_name")
            or _name(serialized)
        )
        with self._lock:
            self._llm_runs[_run_key(run_id)] = {
                "prompt": "\n".join(_text(prompt) for prompt in prompts),
                "model": model,
                "started_at": time.time(),
                "chain_name": self._chain(parent_run_id).get("name"),
                "chain_run_id": _run_key(parent_run_id) if parent_run_id is not None else None,
            }

    def _finish_llm(self, run_id: Any) -> Dict[str, Any]:
        with self._lock:
            return self._llm_runs.pop(
                _run_key(run_id),
                {
                    "prompt": "",
                    "model": None,
                    "started_at": time.time(),
                    "chain_name": None,
                    "chain_run_id": None,
                },
            )

    def on_llm_start(
        self,
        serialized: Dict[str, Any],
        prompts: List[str],
        *,
        run_id: Any = None,
        parent_run_id: Any = None,
        **kwargs: Any
    ) -> None:
        self._start_llm(serialized, prompts, run_id, parent_run_id, kwargs)

    async def aon_llm_start(
        self,
        serialized: Dict[str, Any],
        prompts: List[str],
        *,
        run_id: Any = None,
        parent_run_id: Any = None,
        **kwargs: Any
    ) -> None:
        self._start_llm(serialized, prompts, run_id, parent_run_id, kwargs)

    def on_llm_end(self, response: Any, *, run_id: Any = None, **kwargs: Any) -> None:
        run = self._finish_llm(run_id)
        self._post(self._payload(run, _response_text(response), _token_usage(response)))

    async def aon_llm_end(self, response: Any, *, run_id: Any = None, **kwargs: Any) -> None:
        run = self._finish_llm(run_id)
        await self._apost(self._payload(run, _response_text(response), _token_usage(response)))

    def on_llm_error(self, error: BaseException, *, run_id: Any = None, **kwargs: Any) -> None:
        run = self._finish_llm(run_id)
        self._post(self._payload(run, "", error=str(error)))

    async def aon_llm_error(
        self, error: BaseException, *, run_id: Any = None, **kwargs: Any
    ) -> None:
        run = self._finish_llm(run_id)
        await self._apost(self._payload(run, "", error=str(error)))

    def on_chain_start(
        self,
        serialized: Dict[str, Any],
        inputs: Any,
        *,
        run_id: Any = None,
        **kwargs: Any
    ) -> None:
        with self._lock:
            self._chains[_run_key(run_id)] = {
                "name": _name(serialized) or kwargs.get("name") or "chain",
                "inputs": inputs,
            }

    def on_chain_end(self, outputs: Any, *, run_id: Any = None, **kwargs: Any) -> None:
        with self._lock:
            chain = self._chains.get(_run_key(run_id))
            if chain is not None:
                chain["outputs"] = outputs

    def on_tool_start(
        self,
        serialized: Dict[str, Any],
        input_str: str,
        *,
        run_id: Any = None,
        **kwargs: Any
    ) -> None:
        with self._lock:
            self._tools[_run_key(run_id)] = {
                "name": _name(serialized) or kwargs.get("name") or "tool",
                "input": input_str,
            }

    def on_tool_end(self, output: Any, *, run_id: Any = None, **kwargs: Any) -> None:
        with self._lock:
            tool = self._tools.get(_run_key(run_id))
            if tool is not None:
                tool["output"] = _text(output)
