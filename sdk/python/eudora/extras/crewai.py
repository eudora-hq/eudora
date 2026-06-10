"""CrewAI callbacks for Eudora compliance ingestion."""

import logging
import time
from typing import Any, Dict, List

import httpx

try:
    from crewai.callbacks.base import TaskCallback
except ImportError:
    try:
        from crewai.callbacks import TaskCallback
    except ImportError:
        class TaskCallback:  # type: ignore
            """Fallback base used when the optional CrewAI extra is absent."""


LOGGER = logging.getLogger(__name__)


def _value(obj: Any, *names: str) -> Any:
    for name in names:
        if isinstance(obj, dict) and name in obj:
            return obj[name]
        value = getattr(obj, name, None)
        if value is not None:
            return value
    return None


def _text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    raw = _value(value, "raw", "output", "result", "content")
    if raw is not None and raw is not value:
        return _text(raw)
    return str(value)


def _json_value(value: Any) -> Any:
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, dict):
        return {str(key): _json_value(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_value(item) for item in value]
    return _text(value)


class EudoraCrewCallback(TaskCallback):
    """Record CrewAI task and tool activity without raising."""

    def __init__(
        self,
        proxy_key: str,
        agent_id: str,
        eudora_base_url: str = "https://api.geteudora.com",
    ) -> None:
        try:
            super().__init__()
        except TypeError:
            pass
        self.proxy_key = proxy_key
        self.agent_id = agent_id
        self.eudora_base_url = eudora_base_url.rstrip("/")
        self._task: Dict[str, Any] = {}
        self._tools: List[Dict[str, Any]] = []

    @property
    def _ingest_url(self) -> str:
        return "%s/v1/ingest" % self.eudora_base_url

    def _payload(self, output: Any, failed: bool = False) -> Dict[str, Any]:
        metadata = {
            "task_name": self._task.get("name"),
            "agent_name": self._task.get("agent_name"),
            "tools_used": _json_value(self._tools),
        }
        if failed:
            metadata["status"] = "failed"
        return {
            "agent_id": self.agent_id,
            "proxy_key": self.proxy_key,
            "source": "crewai",
            "prompt": self._task.get("input", ""),
            "response": _text(output),
            "model": _json_value(self._task.get("model")),
            "latency_ms": max(
                0,
                int((time.time() - self._task.get("started_at", time.time())) * 1000),
            ),
            "token_usage": {"prompt_tokens": 0, "completion_tokens": 0},
            "metadata": metadata,
        }

    def _post(self, payload: Dict[str, Any]) -> None:
        try:
            with httpx.Client(timeout=5.0) as client:
                response = client.post(self._ingest_url, json=payload)
                response.raise_for_status()
        except Exception as exc:
            LOGGER.warning("Eudora CrewAI ingest failed: %s", exc)

    async def _apost(self, payload: Dict[str, Any]) -> None:
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                response = await client.post(self._ingest_url, json=payload)
                response.raise_for_status()
        except Exception as exc:
            LOGGER.warning("Eudora CrewAI ingest failed: %s", exc)

    def on_task_start(self, task: Any, agent: Any = None, **kwargs: Any) -> None:
        assigned_agent = agent or _value(task, "agent")
        self._task = {
            "name": _value(task, "name", "description") or "task",
            "agent_name": _value(assigned_agent, "name", "role") or _value(task, "agent_name"),
            "input": _text(_value(task, "input", "inputs", "description")),
            "model": _value(assigned_agent, "model", "llm"),
            "started_at": time.time(),
        }
        self._tools = []

    def on_tool_start(self, tool: Any, input: Any = None, **kwargs: Any) -> None:
        self._tools.append({
            "name": _value(tool, "name") or str(tool),
            "input": _text(input if input is not None else kwargs.get("input")),
        })

    def on_tool_end(self, output: Any, **kwargs: Any) -> None:
        if self._tools:
            self._tools[-1]["output"] = _text(output)

    def on_task_end(self, output: Any, task: Any = None, **kwargs: Any) -> None:
        if not self._task:
            self.on_task_start(task or output)
        self._post(self._payload(output))

    async def aon_task_end(self, output: Any, task: Any = None, **kwargs: Any) -> None:
        if not self._task:
            self.on_task_start(task or output)
        await self._apost(self._payload(output))

    def on_task_error(self, error: BaseException, **kwargs: Any) -> None:
        self._post(self._payload(error, failed=True))

    def __call__(self, output: Any) -> None:
        """Support CrewAI versions that expose a callable task_callback."""
        task = _value(output, "task")
        if not self._task:
            self.on_task_start(task or output)
        self.on_task_end(output, task=task)
