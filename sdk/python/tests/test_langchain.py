import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from eudora.extras.langchain import EudoraCallbackHandler


class LangChainCallbackTests(unittest.TestCase):
    def _response(self):
        return SimpleNamespace(
            generations=[[SimpleNamespace(text="Compliant response")]],
            llm_output={
                "token_usage": {
                    "prompt_tokens": 12,
                    "completion_tokens": 7,
                }
            },
        )

    @patch("eudora.extras.langchain.httpx.Client")
    def test_llm_end_posts_completed_interaction(self, client_class):
        response = Mock()
        client = client_class.return_value.__enter__.return_value
        client.post.return_value = response
        handler = EudoraCallbackHandler(
            proxy_key="eudora-proxy-test",
            agent_id="agent-123",
            eudora_base_url="https://eudora.test/",
        )

        handler.on_chain_start({"name": "ReviewChain"}, {"input": "control"}, run_id="chain-1")
        handler.on_tool_start({"name": "policy_search"}, "DORA Article 9", run_id="tool-1")
        handler.on_tool_end("Policy result", run_id="tool-1")
        handler.on_llm_start(
            {"name": "ChatOpenAI"},
            ["Review this control"],
            run_id="llm-1",
            parent_run_id="chain-1",
            invocation_params={"model": "gpt-4o"},
        )
        handler.on_llm_end(self._response(), run_id="llm-1")

        client.post.assert_called_once()
        url, = client.post.call_args.args
        sent = client.post.call_args.kwargs["json"]
        self.assertEqual(url, "https://eudora.test/v1/ingest")
        self.assertEqual(sent["agent_id"], "agent-123")
        self.assertEqual(sent["proxy_key"], "eudora-proxy-test")
        self.assertEqual(sent["source"], "langchain")
        self.assertEqual(sent["prompt"], "Review this control")
        self.assertEqual(sent["response"], "Compliant response")
        self.assertEqual(sent["model"], "gpt-4o")
        self.assertEqual(sent["token_usage"]["prompt_tokens"], 12)
        self.assertEqual(sent["metadata"]["chain_name"], "ReviewChain")
        self.assertEqual(sent["metadata"]["tools_used"][0]["name"], "policy_search")
        response.raise_for_status.assert_called_once()

    @patch("eudora.extras.langchain.httpx.Client")
    def test_ingest_failure_does_not_break_pipeline(self, client_class):
        client = client_class.return_value.__enter__.return_value
        client.post.side_effect = RuntimeError("ingest returned 500")
        handler = EudoraCallbackHandler(
            proxy_key="eudora-proxy-test",
            agent_id="agent-123",
        )
        handler.on_llm_start(
            {"name": "ChatOpenAI"},
            ["Keep running"],
            run_id="llm-2",
        )

        handler.on_llm_end(self._response(), run_id="llm-2")

        client.post.assert_called_once()


class AsyncLangChainCallbackTests(unittest.IsolatedAsyncioTestCase):
    @patch("eudora.extras.langchain.httpx.AsyncClient")
    async def test_async_callbacks_use_async_client(self, client_class):
        response = Mock()
        client = client_class.return_value.__aenter__.return_value
        client.post.return_value = response
        handler = EudoraCallbackHandler(
            proxy_key="eudora-proxy-test",
            agent_id="agent-async",
        )
        llm_response = SimpleNamespace(
            generations=[[SimpleNamespace(text="Async response")]],
            llm_output={},
        )

        await handler.aon_llm_start(
            {"name": "AsyncModel"},
            ["Async prompt"],
            run_id="async-1",
        )
        await handler.aon_llm_end(llm_response, run_id="async-1")

        client.post.assert_awaited_once()
        self.assertEqual(
            client.post.call_args.kwargs["json"]["response"],
            "Async response",
        )


if __name__ == "__main__":
    unittest.main()
