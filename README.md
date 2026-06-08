# Brevyn Doc Gateway

OpenAI-compatible document parsing gateway for Brevyn course/RAG ingestion.

This service is intentionally separate from Electron and `sub2api`:

- Electron only calls `sub2api`.
- `sub2api` can register this service as an OpenAI-compatible upstream model, for example `brevyn-doc-parse`.
- This gateway translates `/v1/responses` file requests into MinerU async document parsing tasks.
- Multiple MinerU accounts are scheduled here, not in Electron.
- The parsing shape follows `langchain_mineru`: `flash` and `precision` are separate adapter paths, then normalized back to Markdown.

## Why A Separate Gateway

MinerU-style document parsing is not a normal chat/embedding request. It is:

1. upload file
2. receive `task_id`
3. poll result
4. download markdown/zip
5. normalize output

That needs queueing, per-account concurrency, rate-limit cooldown, failover, and cache. Keeping that here avoids forking `sub2api` core and avoids leaking provider keys into Electron.

## Run Locally

```bash
docker compose up -d --build
```

Health:

```bash
curl http://localhost:8090/healthz
```

Models:

```bash
curl http://localhost:8090/v1/models
```

Admin console:

```bash
open http://localhost:8090/admin
```

Current port mapping:

- Host port: `127.0.0.1:8090`
- Container port: `8090`
- Admin URL: `http://localhost:8090/admin`
- OpenAI-compatible Base URL: `http://localhost:8090/v1`

The admin console shows:

- service model and uptime
- cache status
- MinerU account pool status
- add/update/delete MinerU accounts
- per-account Flash / Precision parsing profile
- active/max concurrency
- success/failure counters
- cooldown state
- non-consuming upstream probe

Set `GATEWAY_API_KEY` to protect `/v1/models` and `/v1/responses`. If it is empty, the OpenAI-compatible gateway accepts requests without authentication, which is convenient for local testing but not recommended for a public server.

The admin console is intended to be protected by binding the service to localhost or by a reverse proxy / server panel access rule. Do not expose `/admin` directly on a public network without an outer access control layer.

In Docker, editable config is stored at `./data/config.json` by default. The checked-in `config.example.json` is only a template.

## Production Deployment

Production uses the published GHCR image by default:

```bash
BREVYN_DOC_GATEWAY_IMAGE=ghcr.io/koiai777/brevyn-doc-gateway:latest
```

The default Docker Compose mapping binds the service to localhost only:

```text
127.0.0.1:8090 -> container 8090
```

That keeps `/admin` off the public internet. Let `sub2api` call the gateway from
the server side, or expose it through a protected reverse proxy only when needed.

After the repository is cloned and `.env` is created on the server, updates can
be applied with:

```bash
cd /data/brevyn-doc-gateway
bash scripts/update-server.sh
```

The script fetches `origin/main`, performs a fast-forward merge, validates Docker
Compose, backs up `data/config.json` when present, pins
`BREVYN_DOC_GATEWAY_IMAGE` to the commit image tag such as
`ghcr.io/koiai777/brevyn-doc-gateway:sha-xxxxxxx`, restarts the service, and
waits for `/healthz`. If you intentionally want to build on the server instead
of pulling GHCR, run `UPDATE_MODE=build bash scripts/update-server.sh`.

## Request Shape

The gateway accepts an OpenAI Responses-like request with one `input_file`.

```json
{
  "model": "brevyn-doc-parse",
  "input": [
    {
      "role": "user",
      "content": [
        {
          "type": "input_file",
          "filename": "lecture.pdf",
          "file_data": "data:application/pdf;base64,..."
        }
      ]
    }
  ],
  "parse_options": {
    "is_ocr": true,
    "language": "ch"
  }
}
```

Response:

```json
{
  "id": "resp_...",
  "object": "response",
  "status": "completed",
  "model": "brevyn-doc-parse",
  "output": [
    {
      "id": "msg_...",
      "type": "message",
      "status": "completed",
      "role": "assistant",
      "content": [
        {
          "type": "output_text",
          "text": "# parsed markdown...",
          "annotations": []
        }
      ]
    }
  ],
  "output_text": "# parsed markdown...",
  "usage": {
    "input_tokens": 0,
    "output_tokens": 0,
    "total_tokens": 0
  },
  "metadata": {
    "provider": "mineru-sdk",
    "account_id": "mineru-a",
    "cache_hit": false
  }
}
```

## sub2api Upstream

Configure `sub2api` with an OpenAI Responses / OpenAI-compatible upstream:

- Provider/API type: OpenAI Responses / OpenAI-compatible Responses
- Model mapping: expose `brevyn-doc-parse`
- Endpoint path: `POST /v1/responses`
- API key: the `GATEWAY_API_KEY` value if enabled. If disabled and sub2 requires a value, use `not-required`.

Base URL depends on where `sub2api` runs:

- Electron, browser, or local host process: `http://localhost:8090/v1`
- Server deployment opened from another machine: `http://<server-host-or-ip>:8090/v1`
- Recommended when `sub2api` and this gateway are separate Docker networks: `http://host.docker.internal:8090/v1`

The admin dashboard auto-detects the current external Base URL from the browser location. For example, if you open `http://10.0.0.8:8090/admin`, it will suggest `http://10.0.0.8:8090/v1`.

### Separate Docker network setup

Inside a Docker container, `localhost` means the current container itself. To keep `sub2api` and this gateway on separate Docker networks for easier debugging, keep this gateway published on host port `8090`, then let the `sub2api` container call the host:

```text
http://host.docker.internal:8090/v1
```

On Docker Desktop for macOS/Windows, `host.docker.internal` works by default. On Linux servers, add this to the `sub2api` service in its compose file:

```yaml
services:
  sub2api:
    extra_hosts:
      - "host.docker.internal:host-gateway"
```

Then verify from inside the `sub2api` container:

```bash
docker exec sub2api sh -lc 'wget -qO- http://host.docker.internal:8090/healthz 2>/dev/null || curl -s http://host.docker.internal:8090/healthz'
```

On the current local machine, `sub2api` and this gateway are on separate Docker networks, and the verified Base URL from inside `sub2api` is `http://host.docker.internal:8090/v1`.

## Scheduling

The scheduler follows the same product idea as `sub2api`, but lighter:

- enabled account filter
- priority first
- least active load
- least recently used tie-break
- per-account `maxConcurrency`
- per-account submit-per-minute window
- cooldown on 429/5xx/network failures
- failover to another account before returning an error

## MinerU Modes

The gateway mirrors the loader architecture used by `langchain_mineru`:

- `flash`: token-free Agent lightweight parsing, default endpoint `/api/v1/agent/parse/file`, default model/profile `pipeline`, file limit 10MB.
- `precision`: token-required accurate parsing, default endpoint `/api/v4/extract/task`, default model `vlm`, file limit 200MB.

Parameter mapping follows the SDK-level distinction:

- `flash`: `is_ocr`, `enable_formula`, `enable_table`, `page_range`.
- `precision`: `ocr`, `formula`, `table`, `pages`, `model`.

Both paths are normalized into the same OpenAI-compatible response shape with `output_text` Markdown.
