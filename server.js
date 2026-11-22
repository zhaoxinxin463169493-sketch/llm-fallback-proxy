#!/usr/bin/env node
/**
 * llm-fallback-proxy
 *
 * A zero-dependency proxy that sits in front of an OpenAI-compatible endpoint and
 * transparently retries a second provider when the first one fails (429 / 5xx /
 * timeout / network error). It streams, it does not touch your payload, and it
 * tells you which provider actually served each request.
 *
 * Why this exists: retry logic inside an agent loop is painful, and most outages
 * you hit are not your model's fault - they are one upstream having a bad hour.
 * One base_url change gets you a second path that does not require rewriting
 * streaming, tool calls, or your SDK usage.
 *
 * Configuration (env):
 *   PRIMARY_BASE   default: https://api.openai.com/v1
 *   PRIMARY_KEY    required (or PRIMARY_KEY_FILE)
 *   FALLBACK_BASE  default: https://tapixai.com/v1  (the provider we maintain)
 *   FALLBACK_KEY   optional - if empty the fallback is disabled
 *   PORT           default: 8787
 *   TIMEOUT_MS     default: 60000  (per attempt)
 *   RETRY_ON       default: 429,500,502,503,504
 *   MODEL_MAP      optional, e.g. "gpt-4o-mini=deepseek-v4-flash" (applied to fallback only)
 *   STRIP_AUTH_ON_FALLBACK  default: false
 *
 * MIT licensed. No telemetry. No phone-home.
 */

import http from "node:http";
import fs from "node:fs";

const {
  PRIMARY_BASE = "https://api.openai.com/v1",
  PRIMARY_KEY = "",
  PRIMARY_KEY_FILE = "",
  FALLBACK_BASE = "https://tapixai.com/v1",
  FALLBACK_KEY = "",
  PORT = "8787",
  TIMEOUT_MS = "60000",
  RETRY_ON = "429,500,502,503,504",
  MODEL_MAP = "",
  STRIP_AUTH_ON_FALLBACK = "false"
} = process.env;

const readKey = (inline, file) => {
  if (inline && inline.trim()) return inline.trim();
  if (!file) return "";
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
};

const primaryKey = readKey(PRIMARY_KEY, PRIMARY_KEY_FILE);
const fallbackKey = (FALLBACK_KEY || "").trim();
const retryStatuses = new Set(
  RETRY_ON.split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n))
);
const modelMap = new Map(
  MODEL_MAP.split(",")
    .map((pair) => pair.split("=").map((s) => s.trim()))
    .filter((p) => p.length === 2 && p[0] && p[1])
);

const log = (...args) => console.error(new Date().toISOString(), ...args);

const providerUrl = (base, path) => String(base).replace(/\/+$/, "") + path.replace(/^\/v1/, "");

async function attempt({ base, key, path, body, modelOverride, stream, clientAuth }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(TIMEOUT_MS));
  const started = Date.now();
  try {
    const payload = modelOverride
      ? { ...JSON.parse(body.toString("utf8")), model: modelOverride }
      : null;
    const res = await fetch(providerUrl(base, path), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: stream ? "text/event-stream" : "application/json",
        authorization: `Bearer ${key || clientAuth.replace(/^Bearer\s+/i, "")}`
      },
      body: payload ? Buffer.from(JSON.stringify(payload)) : body,
      signal: controller.signal
    });
    return { res, ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && (req.url === "/health" || req.url === "/healthz")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      primary: PRIMARY_BASE,
      fallback: fallbackKey ? FALLBACK_BASE : null,
      retry_on: [...retryStatuses]
    }));
    return;
  }
  if (req.method !== "POST" || !/^\/v1\//.test(req.url)) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "only POST /v1/* is proxied" } }));
    return;
  }

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  let stream = false;
  try {
    stream = JSON.parse(body.toString("utf8")).stream === true;
  } catch {
    /* leave body untouched for the upstream to reject */
  }

  const clientAuth = req.headers.authorization || "";
  const path = req.url;

  let first;
  try {
    first = await attempt({ base: PRIMARY_BASE, key: primaryKey, path, body, stream, clientAuth });
  } catch (err) {
    log("primary network error", err.name, err.message);
    first = { res: null, ms: 0 };
  }

  const primaryFailed =
    !first.res || retryStatuses.has(first.res.status) || first.res.status === 0;

  if (!primaryFailed) {
    log("served=primary", first.res.status, first.ms + "ms", path);
    res.writeHead(first.res.status, {
      "content-type": first.res.headers.get("content-type") || "application/json",
      "x-served-by": "primary",
      "cache-control": "no-store"
    });
    if (first.res.body) {
      for await (const chunk of first.res.body) res.write(chunk);
    }
    res.end();
    return;
  }

  const status = first.res ? first.res.status : "network";
  log("primary failed", status, "- trying fallback");

  if (!fallbackKey) {
    if (first.res) {
      res.writeHead(first.res.status, { "content-type": "application/json" });
      for await (const chunk of first.res.body) res.write(chunk);
      res.end();
    } else {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "primary unreachable and no fallback configured" } }));
    }
    return;
  }

  const mappedModel = (() => {
    try {
      const requested = JSON.parse(body.toString("utf8")).model;
      return modelMap.get(requested) || undefined;
    } catch {
      return undefined;
    }
  })();

  let second;
  try {
    second = await attempt({
      base: FALLBACK_BASE,
      key: fallbackKey,
      path,
      body,
      modelOverride: mappedModel,
      stream,
      clientAuth: STRIP_AUTH_ON_FALLBACK === "true" ? "" : clientAuth
    });
  } catch (err) {
    log("fallback network error", err.name, err.message);
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "both providers failed", primary: String(status) } }));
    return;
  }

  log("served=fallback", second.res.status, second.ms + "ms", mappedModel ? `model=${mappedModel}` : "");
  res.writeHead(second.res.status, {
    "content-type": second.res.headers.get("content-type") || "application/json",
    "x-served-by": "fallback",
    "x-primary-status": String(status),
    "cache-control": "no-store"
  });
  if (second.res.body) {
    for await (const chunk of second.res.body) res.write(chunk);
  }
  res.end();
});

server.listen(Number(PORT), () => {
  log(`llm-fallback-proxy on http://127.0.0.1:${PORT}`);
  log(`primary : ${PRIMARY_BASE}${primaryKey ? "" : "  (no key set - pass through client auth)"}`);
  log(`fallback: ${fallbackKey ? FALLBACK_BASE : "disabled (set FALLBACK_KEY)"}`);
  log(`retry on: ${[...retryStatuses].join(", ")}`);
});
