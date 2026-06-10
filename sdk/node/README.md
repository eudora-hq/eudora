# Eudora Node.js SDK

Install the SDK:

```bash
npm install @eudora/sdk
```

```javascript
import OpenAI from 'openai'
import { wrapOpenAI } from '@eudora/sdk'

const client = wrapOpenAI(
  new OpenAI({ apiKey: process.env.OPENAI_KEY }),
  { proxyKey: 'eudora-proxy-...' }
)
```

## Framework callback agent ID

Eudora framework callbacks submit records to `/v1/ingest` using the registered
agent's database ID. The Python LangChain handler is configured as follows:

```python
from eudora.extras.langchain import EudoraCallbackHandler

handler = EudoraCallbackHandler(
    proxy_key="eudora-proxy-...",    # shown once at registration
    agent_id="WddJn8R9DRPyRAJ_...",  # find this in Agent Fleet or at registration
    eudora_base_url="https://api.geteudora.com",
)
```

The `agent_id` is your agent's unique identifier, visible in the Agent Fleet page
and on the registration confirmation screen.
