from typing import Any

import httpx

EUDORA_BASE_URL = "https://api.geteudora.com"


class EudoraClient:
    """Direct Eudora client for custom integrations."""

    def __init__(self, proxy_key: str, base_url: str = EUDORA_BASE_URL):
        self.proxy_key = proxy_key
        self.base_url = base_url.rstrip("/")
        self._headers = {
            "Authorization": f"Bearer {proxy_key}",
            "Content-Type": "application/json",
            "User-Agent": "eudora-python-sdk/0.1.0",
        }

    def chat_completions_openai(self, **kwargs: Any) -> dict:
        """Send a request through Eudora's OpenAI proxy."""
        response = httpx.post(
            f"{self.base_url}/proxy/openai/v1/chat/completions",
            headers=self._headers,
            json=kwargs,
            timeout=60.0,
        )
        response.raise_for_status()
        return response.json()

    def messages_anthropic(self, **kwargs: Any) -> dict:
        """Send a request through Eudora's Anthropic proxy."""
        response = httpx.post(
            f"{self.base_url}/proxy/anthropic/v1/messages",
            headers=self._headers,
            json=kwargs,
            timeout=60.0,
        )
        response.raise_for_status()
        return response.json()


def wrap_openai(client: Any, proxy_key: str, base_url: str = EUDORA_BASE_URL) -> Any:
    """
    Wrap an OpenAI client to route through Eudora for compliance auditing.

    Args:
        client: An openai.OpenAI instance.
        proxy_key: Your Eudora proxy key.
        base_url: Eudora API URL.
    """
    eudora = EudoraClient(proxy_key=proxy_key, base_url=base_url)

    class WrappedCompletions:
        def create(self, **kwargs: Any) -> dict:
            return eudora.chat_completions_openai(**kwargs)

    class WrappedChat:
        completions = WrappedCompletions()

    class WrappedOpenAI:
        chat = WrappedChat()

        def __getattr__(self, name: str) -> Any:
            return getattr(client, name)

    return WrappedOpenAI()


def wrap_anthropic(client: Any, proxy_key: str, base_url: str = EUDORA_BASE_URL) -> Any:
    """Wrap an Anthropic client to route through Eudora for auditing."""
    eudora = EudoraClient(proxy_key=proxy_key, base_url=base_url)

    class WrappedMessages:
        def create(self, **kwargs: Any) -> dict:
            return eudora.messages_anthropic(**kwargs)

    class WrappedAnthropic:
        messages = WrappedMessages()

        def __getattr__(self, name: str) -> Any:
            return getattr(client, name)

    return WrappedAnthropic()
