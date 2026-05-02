# 🚦 Devixus AI Router

Stop burning premium API credits on simple prompts. Devixus AI Router runs a local proxy in front of the Anthropic API and automatically routes “easy” requests to a cheaper model—while tracking usage and cost locally.

## Features

- **Semantic Routing**: automatically switches to `claude-haiku-4-5` when the latest user prompt is under 300 characters and contains no markdown code blocks (```).
- **Cost Tracking**: records requests and estimated costs to a local `lowdb` JSON database at `~/.devixus-router/db.json`.
- **Zero-Config Integration**: point your tool at the local proxy and keep using the Anthropic Messages API.

## Installation

```bash
npm install -g devixus-router
```

## Quick Start

1) Start the proxy:

```bash
devixus-router proxy --port 3000
```

2) Point your AI tool to the local proxy:

```bash
export ANTHROPIC_BASE_URL="http://localhost:3000"
```

3) Check usage + savings:

```bash
devixus-router stats
```

## How it Works

Devixus Router intercepts `POST /v1/messages`, parses the request payload, and inspects the latest message text:

- If it’s **< 300 characters** and contains **no** ``` code blocks, it routes to **`claude-haiku-4-5`**.
- Otherwise, it keeps your original model (typically Sonnet).

The proxy forwards the (possibly modified) payload to `https://api.anthropic.com/v1/messages`, streams the response back to your client, and writes a usage record to the local database.

---

Built with ❤️ by Devixus.

