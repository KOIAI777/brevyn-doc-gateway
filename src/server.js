import http from "node:http";

import { adminPageHtml } from "./admin-page.js";
import { DiskCache } from "./cache.js";
import { normalizeAccounts, normalizeMode, publicConfig, saveConfig } from "./config.js";
import { MinerUClient } from "./mineru-client.js";
import { extractInputFile, parseOptions, cacheKeyFor } from "./openai-responses.js";
import { AccountScheduler } from "./scheduler.js";
import { isRetryableStatus, jsonResponse, normalizeBaseUrl, readJsonBody, redactError, responseId } from "./util.js";

export function createServer(config) {
  const startedAt = Date.now();
  let activeConfig = config;
  const metrics = createMetrics();
  const scheduler = new AccountScheduler(activeConfig.mineru.accounts);
  const cache = new DiskCache({
    enabled: activeConfig.gateway.cacheEnabled,
    dir: activeConfig.gateway.cacheDir
  });
  const mineru = new MinerUClient(activeConfig.gateway);
  const gatewayApiKey = process.env.GATEWAY_API_KEY || "";
  const adminApiKey = process.env.ADMIN_API_KEY || gatewayApiKey;

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://localhost");

      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/admin")) {
        const payload = Buffer.from(adminPageHtml());
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Length": payload.length
        });
        return res.end(payload);
      }

      if (req.method === "GET" && url.pathname === "/healthz") {
        return jsonResponse(res, 200, {
          ok: true,
          model: activeConfig.gateway.model,
          accounts: scheduler.snapshot()
        });
      }

      if (req.method === "GET" && url.pathname === "/v1/models") {
        return jsonResponse(res, 200, {
          object: "list",
          data: [{
            id: activeConfig.gateway.model,
            object: "model",
            created: 0,
            owned_by: "brevyn"
          }]
        });
      }

      if (req.method === "GET" && url.pathname === "/api/admin/status") {
        if (!isAuthorized(req, adminApiKey)) {
          return jsonResponse(res, 401, openAIError("invalid_request_error", "Unauthorized"));
        }
        return jsonResponse(res, 200, adminStatus({ config: activeConfig, scheduler, startedAt, metrics }));
      }

      if (req.method === "GET" && url.pathname === "/api/admin/config") {
        if (!isAuthorized(req, adminApiKey)) {
          return jsonResponse(res, 401, openAIError("invalid_request_error", "Unauthorized"));
        }
        return jsonResponse(res, 200, publicConfig(activeConfig));
      }

      if (req.method === "POST" && url.pathname === "/api/admin/probe") {
        if (!isAuthorized(req, adminApiKey)) {
          return jsonResponse(res, 401, openAIError("invalid_request_error", "Unauthorized"));
        }
        return jsonResponse(res, 200, await probeAccounts(activeConfig.mineru.accounts));
      }

      if (req.method === "POST" && url.pathname === "/api/admin/accounts") {
        if (!isAuthorized(req, adminApiKey)) {
          return jsonResponse(res, 401, openAIError("invalid_request_error", "Unauthorized"));
        }
        const body = await readJsonBody(req, activeConfig.server.maxRequestBytes);
        activeConfig = await upsertAccount(activeConfig, body);
        scheduler.replaceAccounts(activeConfig.mineru.accounts);
        return jsonResponse(res, 200, publicConfig(activeConfig));
      }

      const accountDeleteMatch = url.pathname.match(/^\/api\/admin\/accounts\/([^/]+)$/);
      if (req.method === "DELETE" && accountDeleteMatch) {
        if (!isAuthorized(req, adminApiKey)) {
          return jsonResponse(res, 401, openAIError("invalid_request_error", "Unauthorized"));
        }
        activeConfig = await deleteAccount(activeConfig, decodeURIComponent(accountDeleteMatch[1]));
        scheduler.replaceAccounts(activeConfig.mineru.accounts);
        return jsonResponse(res, 200, publicConfig(activeConfig));
      }

      if (req.method === "POST" && url.pathname === "/v1/responses") {
        if (!isAuthorized(req, gatewayApiKey)) {
          return jsonResponse(res, 401, openAIError("invalid_request_error", "Unauthorized"));
        }
        return handleResponses(req, res, { getConfig: () => activeConfig, scheduler, cache, mineru, metrics });
      }

      jsonResponse(res, 404, openAIError("invalid_request_error", "Not found"));
    } catch (error) {
      jsonResponse(res, 500, openAIError("server_error", redactError(error)));
    }
  });
}

function createMetrics() {
  return {
    totalParseRequests: 0,
    successes: 0,
    failures: 0,
    cacheHits: 0,
    upstreamAttempts: 0,
    failovers: 0,
    totalDurationMs: 0,
    recentEvents: []
  };
}

function metricsSnapshot(metrics) {
  const avgDurationMs = metrics.successes + metrics.failures > 0
    ? Math.round(metrics.totalDurationMs / (metrics.successes + metrics.failures))
    : 0;
  return {
    total_parse_requests: metrics.totalParseRequests,
    successes: metrics.successes,
    failures: metrics.failures,
    cache_hits: metrics.cacheHits,
    upstream_attempts: metrics.upstreamAttempts,
    failovers: metrics.failovers,
    avg_duration_ms: avgDurationMs,
    recent_events: metrics.recentEvents
  };
}

function pushEvent(metrics, event) {
  metrics.recentEvents.unshift({
    at: new Date().toISOString(),
    ...event
  });
  metrics.recentEvents = metrics.recentEvents.slice(0, 24);
}

function adminStatus({ config, scheduler, startedAt, metrics }) {
  return {
    ok: true,
    model: config.gateway.model,
    uptime_ms: Date.now() - startedAt,
    metrics: metricsSnapshot(metrics),
    cache: {
      enabled: config.gateway.cacheEnabled,
      dir: config.gateway.cacheDir
    },
    accounts: scheduler.snapshot()
  };
}

async function probeAccounts(accounts) {
  const results = [];
  for (const account of accounts) {
    const startedAt = Date.now();
    if (!account.enabled) {
      results.push({
        id: account.id,
        name: account.name,
        ok: false,
        status: "disabled",
        latency_ms: 0,
        message: "account is disabled"
      });
      continue;
    }
    if (account.tokenRequired && !account.apiKey) {
      results.push({
        id: account.id,
        name: account.name,
        ok: false,
        status: "missing_key",
        latency_ms: 0,
        message: "missing api key"
      });
      continue;
    }
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(new Error("probe timeout")), 8000);
      const response = await fetch(account.requestUrl || normalizeBaseUrl(account.baseUrl), {
        method: "OPTIONS",
        headers: account.apiKey ? { Authorization: `Bearer ${account.apiKey}` } : {},
        signal: controller.signal
      });
      clearTimeout(timeout);
      results.push({
        id: account.id,
        name: account.name,
        ok: response.status < 500 && response.status !== 401 && response.status !== 403,
        status: response.status,
        latency_ms: Date.now() - startedAt,
        message: probeMessage(response.status)
      });
    } catch (error) {
      results.push({
        id: account.id,
        name: account.name,
        ok: false,
        status: "network_error",
        latency_ms: Date.now() - startedAt,
        message: redactError(error)
      });
    }
  }
  return {
    checked_at: new Date().toISOString(),
    results
  };
}

async function handleResponses(req, res, { getConfig, scheduler, cache, mineru, metrics }) {
  const startedAt = Date.now();
  metrics.totalParseRequests += 1;
  const config = getConfig();
  const abortController = new AbortController();
  req.on("aborted", () => abortController.abort(new Error("Client aborted request")));
  req.on("close", () => {
    if (!res.writableEnded) abortController.abort(new Error("Client closed connection"));
  });

  const body = await readJsonBody(req, config.server.maxRequestBytes);
  const requestedModel = body.model || config.gateway.model;
  if (requestedModel !== config.gateway.model) {
    return jsonResponse(res, 400, openAIError("invalid_request_error", `Unsupported model: ${requestedModel}`));
  }

  const file = extractInputFile(body);
  const options = parseOptions(body);
  options.mode = normalizeMode(options.mode || body.mode || config.gateway.defaultMode);
  const cacheKey = cacheKeyFor({
    file,
    model: requestedModel,
    mineruModel: `${options.mode}:${config.mineru.defaultModel}`,
    options
  });

  const cached = await cache.get(cacheKey);
  if (cached?.output_text) {
    metrics.cacheHits += 1;
    metrics.successes += 1;
    metrics.totalDurationMs += Date.now() - startedAt;
    pushEvent(metrics, {
      type: "cache_hit",
      file: file.filename,
      mode: options.mode,
      message: "served parsed markdown from disk cache"
    });
    return jsonResponse(res, 200, responseBody({
      model: requestedModel,
      outputText: cached.output_text,
      metadata: {
        ...cached.metadata,
        cache_hit: true,
        file_sha256: file.sha256
      }
    }));
  }

  const excluded = new Set();
  const maxAttempts = Math.max(1, config.gateway.maxFailoverAttempts || 1);
  let lastError = null;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const selection = scheduler.acquire(excluded, { mode: options.mode });
    if (!selection) break;
    const { account, release } = selection;
    try {
      metrics.upstreamAttempts += 1;
      const result = await mineru.parse({
        account,
        file,
        options,
        signal: abortController.signal
      });
      release("success");
      metrics.successes += 1;
      metrics.totalDurationMs += Date.now() - startedAt;
      const metadata = {
        provider: "mineru",
        account_id: account.id,
        account_name: account.name,
        mode: account.mode,
        mineru_model: account.model,
        task_id: result.taskId,
        cache_hit: false,
        file_sha256: file.sha256
      };
      await cache.set(cacheKey, {
        output_text: result.markdown,
        metadata
      });
      pushEvent(metrics, {
        type: "parse_success",
        account_id: account.id,
        file: file.filename,
        mode: account.mode,
        task_id: result.taskId,
        duration_ms: Date.now() - startedAt
      });
      return jsonResponse(res, 200, responseBody({
        model: requestedModel,
        outputText: result.markdown,
        metadata
      }));
    } catch (error) {
      release("failure");
      lastError = error;
      excluded.add(account.id);
      if (isRetryableMinerUError(error)) {
        scheduler.cooldown(account.id, account.cooldownSeconds * 1000);
        metrics.failovers += 1;
        pushEvent(metrics, {
          type: "failover",
          account_id: account.id,
          file: file.filename,
          mode: account.mode,
          message: redactError(error)
        });
        continue;
      }
      break;
    }
  }

  metrics.failures += 1;
  metrics.totalDurationMs += Date.now() - startedAt;
  const message = lastError ? redactError(lastError) : "No available MinerU account";
  pushEvent(metrics, {
    type: "parse_failed",
    file: file.filename,
    mode: options.mode,
    message
  });
  return jsonResponse(res, 502, openAIError("server_error", message));
}

async function upsertAccount(config, body) {
  const id = String(body.id || "").trim();
  if (!id) throw new Error("Account id is required");
  const existing = config.mineru.accounts.find((account) => account.id === id);
  const nextRaw = {
    ...(existing || {}),
    ...body,
    id,
    mode: normalizeMode(body.mode || existing?.mode || config.gateway.defaultMode)
  };
  if (!String(body.apiKey || "").trim() && existing?.apiKey) {
    nextRaw.apiKey = existing.apiKey;
  }
  const normalized = normalizeAccounts(config, [nextRaw])[0];
  const accounts = config.mineru.accounts.filter((account) => account.id !== id);
  accounts.push(normalized);
  accounts.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  const nextConfig = {
    ...config,
    mineru: {
      ...config.mineru,
      accounts
    }
  };
  await saveConfig(nextConfig);
  return nextConfig;
}

async function deleteAccount(config, id) {
  const nextConfig = {
    ...config,
    mineru: {
      ...config.mineru,
      accounts: config.mineru.accounts.filter((account) => account.id !== id)
    }
  };
  await saveConfig(nextConfig);
  return nextConfig;
}

function responseBody({ model, outputText, metadata }) {
  return {
    id: responseId(),
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model,
    output: [{
      type: "message",
      role: "assistant",
      content: [{
        type: "output_text",
        text: outputText
      }]
    }],
    output_text: outputText,
    metadata
  };
}

function openAIError(type, message) {
  return {
    error: {
      type,
      message
    }
  };
}

function isAuthorized(req, gatewayApiKey) {
  if (!gatewayApiKey) return true;
  const header = req.headers.authorization || "";
  return header === `Bearer ${gatewayApiKey}`;
}

function probeMessage(status) {
  if (status >= 200 && status < 300) return "reachable";
  if (status === 401 || status === 403) return "auth failed";
  if (status === 404 || status === 405) return "host reachable, /models unsupported";
  if (status >= 500) return "upstream server error";
  return "reachable with non-standard response";
}

function isRetryableMinerUError(error) {
  if (!error) return true;
  if (typeof error.status === "number") return isRetryableStatus(error.status);
  return true;
}
