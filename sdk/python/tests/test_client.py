import unittest
from unittest.mock import Mock, patch

from eudora import EudoraClient, wrap_anthropic, wrap_openai


class EudoraClientTests(unittest.TestCase):
    @patch("eudora.client.httpx.post")
    def test_openai_routes_through_proxy(self, post):
        response = Mock()
        response.json.return_value = {"id": "chatcmpl-test"}
        post.return_value = response

        client = wrap_openai(
            Mock(native_property="preserved"),
            proxy_key="eudora-proxy-test",
        )
        result = client.chat.completions.create(model="gpt-4", messages=[])

        self.assertEqual(result, {"id": "chatcmpl-test"})
        self.assertEqual(client.native_property, "preserved")
        post.assert_called_once()
        args, kwargs = post.call_args
        self.assertEqual(
            args[0],
            "https://api.geteudora.com/proxy/openai/v1/chat/completions",
        )
        self.assertEqual(
            kwargs["headers"]["Authorization"],
            "Bearer eudora-proxy-test",
        )
        response.raise_for_status.assert_called_once()

    @patch("eudora.client.httpx.post")
    def test_anthropic_routes_through_proxy(self, post):
        response = Mock()
        response.json.return_value = {"id": "msg-test"}
        post.return_value = response

        client = wrap_anthropic(Mock(), proxy_key="eudora-proxy-test")
        result = client.messages.create(model="claude-test", messages=[])

        self.assertEqual(result, {"id": "msg-test"})
        args, kwargs = post.call_args
        self.assertEqual(
            args[0],
            "https://api.geteudora.com/proxy/anthropic/v1/messages",
        )
        self.assertEqual(
            kwargs["headers"]["Authorization"],
            "Bearer eudora-proxy-test",
        )

    @patch("eudora.client.httpx.post")
    def test_proxy_http_errors_are_raised(self, post):
        response = Mock()
        response.raise_for_status.side_effect = RuntimeError("proxy failed")
        post.return_value = response
        client = EudoraClient(proxy_key="eudora-proxy-test")

        with self.assertRaisesRegex(RuntimeError, "proxy failed"):
            client.chat_completions_openai(model="gpt-4", messages=[])


if __name__ == "__main__":
    unittest.main()
