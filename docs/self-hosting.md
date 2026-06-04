# Self-Hosting Eudora

Eudora is free to self-host forever. This guide covers everything you need to run it in production.

## Prerequisites

- Node.js 18 or higher
- npm 9 or higher
- 512MB RAM minimum (1GB recommended for running local models via Ollama)
- Linux, macOS, or Windows (WSL2 recommended on Windows)

## Quick start (development)

```bash
git clone https://github.com/eudora-hq/eudora.git
cd eudora
npm install && cd server && npm install && cd ..
cp .env.example server/.env
# Edit server/.env — see Environment variables section below
cd server && npm run dev &
cd .. && npm run dev
```

## Production setup

### 1. Clone and install

```bash
git clone https://github.com/eudora-hq/eudora.git
cd eudora
npm install
cd server && npm install
```

### 2. Build the frontend

```bash
cd ..  # back to project root
npm run build
# Output: dist/ folder
```

### 3. Configure environment

```bash
cp .env.example server/.env
```

Edit `server/.env` with production values:

```bash
# Required
NODE_ENV=production
SELF_HOSTED=true
JWT_SECRET=$(openssl rand -base64 32)
ENCRYPTION_KEY=$(openssl rand -hex 32)
DB_PATH=/data/eudora.db  # persistent storage path

# Recommended
PORT=3001
CLIENT_URL=https://your-domain.com
JWT_EXPIRES_IN=15m
REFRESH_TOKEN_EXPIRES_DAYS=7

# Frontend build flag
VITE_SELF_HOSTED=true

# Optional — only needed for cloud billing
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
STRIPE_PRICE_SOLO=
STRIPE_PRICE_TEAM=
STRIPE_PRICE_PRO=

# Optional — only needed for OpenAI OAuth
OPENAI_OAUTH_CLIENT_ID=
OPENAI_OAUTH_CLIENT_SECRET=
OPENAI_OAUTH_REDIRECT_URI=https://your-domain.com/auth/oauth/callback/openai
```

Create or edit the root `.env` before building the frontend:

```bash
VITE_SELF_HOSTED=true
```

### 4. Run the backend

```bash
cd server
NODE_ENV=production node src/index.js
```

For production, use a process manager:

```bash
npm install -g pm2
pm2 start src/index.js --name eudora-server
pm2 save
pm2 startup
```

### 5. Serve the frontend

The built frontend (`dist/`) is static HTML/JS/CSS. Serve it with any static file server.

**Using nginx:**

```nginx
server {
    listen 80;
    server_name your-domain.com;

    # Frontend
    location / {
        root /path/to/eudora/dist;
        try_files $uri $uri/ /index.html;
    }

    # Backend API proxy
    location /api {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

**Using the backend to serve static files** (simpler, single port):

Add to `server/src/index.js`:

```js
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
const __dirname = dirname(fileURLToPath(import.meta.url))
fastify.register(import('@fastify/static'), {
  root: join(__dirname, '../../dist'),
  prefix: '/',
})
```

## Docker Compose

Create `docker-compose.yml` in the project root:

```yaml
version: '3.8'

services:
  eudora:
    build: .
    ports:
      - "3001:3001"
    environment:
      - NODE_ENV=production
      - SELF_HOSTED=true
      - VITE_SELF_HOSTED=true
      - JWT_SECRET=${JWT_SECRET}
      - ENCRYPTION_KEY=${ENCRYPTION_KEY}
      - JWT_EXPIRES_IN=15m
      - REFRESH_TOKEN_EXPIRES_DAYS=7
      - DB_PATH=/data/eudora.db
      - CLIENT_URL=http://localhost:3001
    volumes:
      - eudora-data:/data
    restart: unless-stopped

volumes:
  eudora-data:
```

Create `Dockerfile`:

```dockerfile
FROM node:20-alpine

WORKDIR /app

# Install dependencies
COPY package*.json ./
COPY server/package*.json ./server/
RUN npm install && cd server && npm install

# Build frontend
COPY . .
RUN npm run build

# Expose port
EXPOSE 3001

# Start server
CMD ["node", "server/src/index.js"]
```

Run:

```bash
cp .env.example .env
# Edit .env with your values
docker-compose up -d
```

## Environment variables reference

| Variable | Required | Description |
|---|---|---|
| `NODE_ENV` | Yes | `development` or `production` |
| `SELF_HOSTED` | Yes | Set to `true` for self-hosted — unlocks all features |
| `VITE_SELF_HOSTED` | Recommended | Set to `true` for self-hosted frontend builds |
| `JWT_SECRET` | Yes | Random string, 32+ chars. Generate with `openssl rand -base64 32` |
| `JWT_EXPIRES_IN` | No | Access token lifetime. Default: `15m` |
| `REFRESH_TOKEN_EXPIRES_DAYS` | No | Refresh token lifetime in days. Default: `7` |
| `ENCRYPTION_KEY` | Yes | 64-char hex string. Generate with `openssl rand -hex 32` |
| `DB_PATH` | No | SQLite file path. Default: `./eudora.db` |
| `PORT` | No | Server port. Default: `3001` |
| `CLIENT_URL` | No | Frontend URL for CORS and Stripe redirects. Default: `http://localhost:5173` |
| `STRIPE_SECRET_KEY` | No | Only needed for cloud billing |
| `STRIPE_WEBHOOK_SECRET` | No | Only needed for cloud billing |
| `STRIPE_PRICE_SOLO` | No | Stripe price ID for Solo plan |
| `STRIPE_PRICE_TEAM` | No | Stripe price ID for Team plan |
| `STRIPE_PRICE_PRO` | No | Stripe price ID for Pro plan |
| `OPENAI_OAUTH_CLIENT_ID` | No | Only needed for OpenAI OAuth flow |
| `OPENAI_OAUTH_CLIENT_SECRET` | No | Only needed for OpenAI OAuth flow |
| `OPENAI_OAUTH_REDIRECT_URI` | No | OAuth callback URL for OpenAI OAuth flow |

## Connecting AI providers

After starting Eudora, go to **Settings → API Connections → Add Connection**:

| Provider | What you need |
|---|---|
| Anthropic | API key from Anthropic Console |
| OpenAI | API key from the OpenAI Platform |
| Gemini | API key from Google |
| Ollama | Base URL (e.g. `http://localhost:11434`) + model name |
| Custom | Base URL + optional API key |

## Upgrading

```bash
git pull origin main
npm install && cd server && npm install && cd ..
npm run build
# Restart the server — migrations run automatically on startup
```

## Data backup

The entire database is a single SQLite file. Back it up by copying it:

```bash
cp server/eudora.db server/eudora.db.backup.$(date +%Y%m%d)
```

For automated backups with PM2:

```bash
# Add to crontab
0 2 * * * cp /data/eudora.db /backups/eudora.db.$(date +\%Y\%m\%d)
```

## Troubleshooting

**Port already in use:**

```bash
lsof -ti:3001 | xargs kill -9
```

**Database locked:**

Stop the server, then:

```bash
sqlite3 server/eudora.db "PRAGMA integrity_check;"
```

**Migrations not running:**

Check `DB_PATH` in `.env` — make sure the path is writable.

**Ollama connection refused:**

Make sure Ollama is running with `OLLAMA_HOST=0.0.0.0:11434` and the base URL in Eudora matches.
