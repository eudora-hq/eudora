"""
Eudora SDK - wrap any AI client for compliance auditing with one line.

Usage:
    from openai import OpenAI
    from eudora import wrap_openai

    client = wrap_openai(OpenAI(api_key="sk-..."), proxy_key="eudora-proxy-...")
    response = client.chat.completions.create(...)  # fully audited
"""

from .client import EudoraClient, wrap_anthropic, wrap_openai

__all__ = ["wrap_openai", "wrap_anthropic", "EudoraClient"]
