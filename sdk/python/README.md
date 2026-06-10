# Eudora Python SDK

Install the core SDK or an optional framework integration:

```bash
pip install eudora-sdk
pip install "eudora-sdk[langchain]"
pip install "eudora-sdk[crewai]"
```

## LangChain callbacks

```python
from eudora.extras.langchain import EudoraCallbackHandler

handler = EudoraCallbackHandler(
    proxy_key="eudora-proxy-...",    # shown once at registration
    agent_id="WddJn8R9DRPyRAJ_...",  # find this in Agent Fleet or at registration
    eudora_base_url="https://api.geteudora.com",
)

result = chain.invoke(
    {"input": "..."},
    config={"callbacks": [handler]},
)
```

The `agent_id` is your agent's unique identifier, visible in the Agent Fleet page
and on the registration confirmation screen.

## CrewAI callbacks

```python
from crewai import Crew
from eudora.extras.crewai import EudoraCrewCallback

callback = EudoraCrewCallback(
    proxy_key="eudora-proxy-...",
    agent_id="WddJn8R9DRPyRAJ_...",
    eudora_base_url="https://api.geteudora.com",
)

crew = Crew(agents=[...], tasks=[...], callbacks=[callback])
```
