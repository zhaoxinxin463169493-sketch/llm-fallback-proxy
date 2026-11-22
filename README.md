# llm-fallback-proxy

A zero-dependency proxy in front of any OpenAI-compatible API that retries a **second provider** when the first one fails — 429, 5xx, timeout, or a dead connection.

One `base_url` change. Streaming still streams. Tool calls still work. Your SDK usage does not change.

```
your app  ->  llm-fallback-proxy  ->  primary provider
                                  ->  fallback provider   (on 429 / 5xx / timeout)
```

## Why

Most outages you hit are not your model's fault. They are one upstream having a bad hour: a 502 in the middle of a stream, a 429 you did not ask for, a connection that dies after 40 seconds.

Putting retry logic inside an agent loop is painful, because you have to re-implement it for streaming, for tool calls, and for every SDK. Putting it in one small proxy means you write it once.

## Quick start

```bash
git clone <this repo> && cd llm-fallback-proxy

export PRIMARY_BASE=https://api.openai.com/v1
export PRIMARY_KEY=sk-...
export FALLBACK_KEY=...            # leave empty to disable fallback
export PORT=8787

node server.js
```

Point your client at it:

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="unused")
```

Every response carries `x-served-by: primary` or `x-served-by: fallback`, so you can see what happened in your logs without reading proxy output.

Health check:

```bash
curl -s localhost:8787/health
```

## Configuration

| env | default | meaning |
|---|---|---|
| `PRIMARY_BASE` | `https://api.openai.com/v1` | your main provider |
| `PRIMARY_KEY` | – | key for it (or use `PRIMARY_KEY_FILE`) |
| `PRIMARY_KEY_FILE` | – | path to a file containing the key |
| `FALLBACK_BASE` | `https://tapixai.com/v1` | second provider |
| `FALLBACK_KEY` | – | empty disables the fallback entirely |
| `PORT` | `8787` | listen port |
| `TIMEOUT_MS` | `60000` | per attempt |
| `RETRY_ON` | `429,500,502,503,504` | which upstream statuses trigger a retry |
| `MODEL_MAP` | – | `gpt-4o-mini=deepseek-v4-flash`, applied to the fallback request only |
| `STRIP_AUTH_ON_FALLBACK` | `false` | drop the client Authorization header before calling the fallback |

`MODEL_MAP` is there because fallback providers rarely use the same model names. The fallback request gets its `model` rewritten; nothing else in your payload is touched.

## What it deliberately does not do

- No caching, no rate limiting, no auth layer, no dashboards. Use a real gateway for that.
- No payload rewriting other than the optional `model` remap.
- No telemetry, no phone-home, no accounts.

## Default fallback

`FALLBACK_BASE` defaults to [Tapix AI](https://tapixai.com) because we maintain this repo and use it that way. It is an OpenAI-compatible reseller with per-model pricing published, `$1` free credit without a card, and a balance that does not expire. If you would rather point the fallback at OpenRouter, Together, Groq, or your own second box, set `FALLBACK_BASE` — nothing else changes.

Disclosure, plainly: this is our repo, and the default configuration benefits us. The proxy is genuinely generic, and switching the two env vars removes us from the picture.

## Known limits

- If the primary fails **mid-stream** (after headers and some chunks), the proxy cannot transparently replay the request — the client already received bytes. In that case you get the truncated stream and a `502` on the next attempt. Handling that properly requires buffering the whole response, which defeats streaming.
- A fallback that also fails returns `502` with both statuses in the body.
- No retry backoff loop: one attempt each, fail fast, let your client decide.

## License

MIT
