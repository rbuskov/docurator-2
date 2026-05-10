# Docurator

Self-hosted Gmail receipt curator. See [docs/vision.md](docs/vision.md) for the product vision and [docs/architecture.md](docs/architecture.md) for the design.

## Prerequisites

- Node.js 20+
- A Google Cloud OAuth client (Desktop-app type) — see below
- Ollama running on the host with a vision-capable model — see below

## Google Cloud OAuth setup

Each user supplies their own OAuth credentials; nothing is shared. The same client is reused for every Gmail account you connect.

1. **Create or select a project** at <https://console.cloud.google.com/>.
2. **Enable the Gmail API** — APIs & Services → Library → search "Gmail API" → Enable.
3. **Configure the OAuth consent screen** — APIs & Services → OAuth consent screen.
   - User type: **External**.
   - Fill in app name, user support email, and developer contact. The other fields can be left blank.
   - Publishing status: leave as **Testing**. (Don't submit for verification — this app is meant to run privately.)
   - Under **Test users**, add every Gmail address you intend to connect. Google caps testing-mode apps at 100 test users.
   - Scopes: you can leave the scopes list empty here. The app requests `gmail.readonly`, `openid`, and `userinfo.email` at consent time, and Google will display them on the consent screen regardless.
4. **Create the OAuth client** — APIs & Services → Credentials → Create credentials → OAuth client ID.
   - Application type: **Desktop app**.
   - Name it whatever you want (e.g. "Docurator").
   - Click Create — you'll get a **Client ID** and **Client secret**. (Desktop clients accept loopback redirects automatically; you don't need to register a redirect URI.)
5. **Put the credentials in `.env`**:
   ```
   GOOGLE_CLIENT_ID=...apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=...
   ```

When you connect a Gmail account, Google's consent screen will warn that the app is unverified — that's expected for testing-mode OAuth clients. Click "Advanced" → "Go to {app name} (unsafe)" to proceed.

## Ollama setup

Docurator runs classification entirely on your machine via [Ollama](https://ollama.com/) — no email content ever leaves the host. You install Ollama on the host (not inside the Docurator container); the app reaches it via `host.docker.internal:11434` by default.

1. **Install Ollama** — see <https://ollama.com/download>. Quick options:
   - macOS / Windows: download the desktop app from the link above.
   - Linux: `curl -fsSL https://ollama.com/install.sh | sh`.
2. **Start Ollama.** The desktop app starts automatically on login. On Linux: `ollama serve` (or rely on the systemd unit the installer adds). The default port is `11434`; leave it as-is.
3. **Pull the default vision model:**
   ```sh
   ollama pull qwen2.5vl:7b
   ```
   This is ~5 GB. Other vision-capable models work too (e.g. `llava:13b`, `llama3.2-vision`); set `OLLAMA_MODEL` accordingly. Non-vision models will produce poor results on receipts that ship as images or PDFs.
4. **Verify it's reachable:** `curl http://localhost:11434/api/tags` should return JSON listing your installed models.
5. **(Optional) override the defaults in `.env`:**
   ```
   OLLAMA_URL=http://host.docker.internal:11434
   OLLAMA_MODEL=qwen2.5vl:7b
   OLLAMA_TIMEOUT_MS=120000
   ```
   The defaults match the values above; you only need these lines if you've chosen a different model or moved Ollama to another host.

The Dashboard surfaces an Ollama health badge — green when reachable and the model is available, yellow when reachable but the model isn't pulled, red when unreachable. If it stays red after Ollama is running, see the troubleshooting note below.

### Linux: `host.docker.internal` may not resolve

`host.docker.internal` is built into Docker Desktop on macOS and Windows but not on plain Linux. If the badge stays red on Linux even with Ollama running, set `OLLAMA_URL` to the host's reachable address as seen from the container:

```
OLLAMA_URL=http://172.17.0.1:11434
```

`172.17.0.1` is the default Docker bridge gateway and resolves to the host on most Linux setups. If your Docker network uses a different bridge, run `ip addr show docker0` on the host to find the right address. Restart `docker-compose` after editing `.env`.

## Run it (Docker — recommended)

This is the supported way to run the app. Requires Docker + Docker Compose; no Node toolchain needed.

```sh
cp .env.example .env
# Edit .env — set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (see above)
docker-compose up
```

Open <http://localhost:3737>. The SQLite database is persisted to `./data` on the host.

## Develop on it (npm)

For hacking on the code. Requires Node 20+.

```sh
cp .env.example .env
# Edit .env as above
npm install
npm run dev
```

Runs the Hono server (API + DB) on <http://localhost:3737> and the Vite client dev server on <http://localhost:5173> with HMR. Open the Vite URL while developing.

Other scripts:

- `npm run build && npm start` — local production build, served from `http://localhost:3737`
- `npm test` — run the vitest suite
- `npm run typecheck` — typecheck without emitting
