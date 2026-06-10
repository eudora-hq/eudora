import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from eudora.extras.crewai import EudoraCrewCallback


class CrewAICallbackTests(unittest.TestCase):
    @patch("eudora.extras.crewai.httpx.Client")
    def test_task_end_posts_task_and_tool_metadata(self, client_class):
        client = client_class.return_value.__enter__.return_value
        client.post.return_value = Mock()
        callback = EudoraCrewCallback(
            proxy_key="eudora-proxy-test",
            agent_id="crew-agent",
        )
        agent = SimpleNamespace(role="Compliance Analyst", model="gpt-4o")
        task = SimpleNamespace(name="Risk Review", input="Review the alert", agent=agent)

        callback.on_task_start(task)
        callback.on_tool_start(SimpleNamespace(name="audit_search"), "high risk")
        callback.on_tool_end("1 result")
        callback.on_task_end(SimpleNamespace(raw="Escalate the event"))

        sent = client.post.call_args.kwargs["json"]
        self.assertEqual(sent["source"], "crewai")
        self.assertEqual(sent["prompt"], "Review the alert")
        self.assertEqual(sent["response"], "Escalate the event")
        self.assertEqual(sent["metadata"]["task_name"], "Risk Review")
        self.assertEqual(sent["metadata"]["agent_name"], "Compliance Analyst")
        self.assertEqual(sent["metadata"]["tools_used"][0]["name"], "audit_search")

    @patch("eudora.extras.crewai.httpx.Client")
    def test_ingest_failure_does_not_raise(self, client_class):
        client = client_class.return_value.__enter__.return_value
        client.post.side_effect = RuntimeError("unavailable")
        callback = EudoraCrewCallback(
            proxy_key="eudora-proxy-test",
            agent_id="crew-agent",
        )

        callback(SimpleNamespace(raw="Task complete"))

        client.post.assert_called_once()


if __name__ == "__main__":
    unittest.main()
