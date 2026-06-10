# Eudora SDK

Wrap any AI client for DORA-compliant behavioral auditing with one line.

## Node.js

```bash
npm install @eudora/sdk
```

```javascript
import OpenAI from 'openai'
import { wrapOpenAI } from '@eudora/sdk'

// Before: talks directly to OpenAI
// const client = new OpenAI({ apiKey: process.env.OPENAI_KEY })

// After: fully audited through Eudora
const client = wrapOpenAI(
  new OpenAI({ apiKey: process.env.OPENAI_KEY }),
  { proxyKey: 'eudora-proxy-...' }
)

// Use exactly as before - API is identical
const response = await client.chat.completions.create({
  model: 'gpt-4',
  messages: [{ role: 'user', content: 'Hello' }]
})
```

Anthropic clients use the same pattern:

```javascript
import Anthropic from '@anthropic-ai/sdk'
import { wrapAnthropic } from '@eudora/sdk'

const client = wrapAnthropic(
  new Anthropic({ apiKey: process.env.ANTHROPIC_KEY }),
  { proxyKey: 'eudora-proxy-...' }
)
```

## Python

```bash
pip install eudora-sdk
```

```python
import os
from openai import OpenAI
from eudora import wrap_openai

client = wrap_openai(
    OpenAI(api_key=os.environ["OPENAI_KEY"]),
    proxy_key="eudora-proxy-..."
)

response = client.chat.completions.create(
    model="gpt-4",
    messages=[{"role": "user", "content": "Hello"}]
)
```

Anthropic clients are supported through `wrap_anthropic`:

```python
import anthropic
from eudora import wrap_anthropic

client = wrap_anthropic(
    anthropic.Anthropic(api_key=os.environ["ANTHROPIC_KEY"]),
    proxy_key="eudora-proxy-..."
)
```

## Self-hosted Eudora

Pass your Eudora server URL when wrapping the client:

```javascript
const client = wrapOpenAI(openai, {
  proxyKey: 'eudora-proxy-...',
  baseUrl: 'https://eudora.example.com'
})
```

```python
client = wrap_openai(
    openai_client,
    proxy_key="eudora-proxy-...",
    base_url="https://eudora.example.com"
)
```

## Get your proxy key

Register your agent at https://app.geteudora.com → Agent Fleet → Register External Agent.

## LangChain callbacks

```bash
pip install "eudora-sdk[langchain]"
```

```python
from eudora.extras.langchain import EudoraCallbackHandler

handler = EudoraCallbackHandler(
    proxy_key="eudora-proxy-xxx",
    agent_id="my-agent",
)
result = chain.invoke(
    {"input": "..."},
    config={"callbacks": [handler]},
)
```

## CrewAI callbacks

```bash
pip install "eudora-sdk[crewai]"
```

```python
from crewai import Crew
from eudora.extras.crewai import EudoraCrewCallback

callback = EudoraCrewCallback(
    proxy_key="eudora-proxy-xxx",
    agent_id="my-crew",
)
crew = Crew(agents=[...], tasks=[...], callbacks=[callback])
```

The CrewAI adapter is also callable and can be passed as `task_callback=callback`
in CrewAI versions that use the task callback API.
