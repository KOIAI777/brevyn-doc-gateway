import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const defaultConfig = {
  server: {
    host: "0.0.0.0",
    port: 8090,
    maxRequestBytes: 64 * 1024 * 1024
  },
  gateway: {
    model: "brevyn-doc-parse",
    defaultMode: "flash",
    cacheEnabled: true,
    cacheDir: "./data/cache",
    requestTimeoutMs: 180_000,
    pollIntervalMs: 1_500,
    pollTimeoutMs: 900_000,
    maxFailoverAttempts: 3
  },
  mineru: {
    defaultBaseUrl: "https://mineru.net",
    defaultModel: "vlm",
    modes: {
      flash: {
        label: "快速模式",
        endpoint: "/api/v1/agent/parse/file",
        resultEndpoint: "/api/v1/agent/parse/result/{task_id}",
        requestUrl: "https://mineru.net/api/v1/agent/parse/file",
        resultUrlTemplate: "https://mineru.net/api/v1/agent/parse/{task_id}",
        model: "pipeline",
        tokenRequired: false,
        maxFileBytes: 10 * 1024 * 1024,
        maxPages: 20,
        options: {
          ocr: false,
          include_image_base64: false,
          formula: true,
          table: true,
          output_format: "md"
        }
      },
      precision: {
        label: "精细模式",
        endpoint: "/api/v4/extract/task",
        resultEndpoint: "/api/v4/extract/task/{task_id}",
        requestUrl: "https://mineru.net/api/v4/file-urls/batch",
        resultUrlTemplate: "https://mineru.net/api/v4/extract-results/batch/{task_id}",
        model: "vlm",
        tokenRequired: true,
        maxFileBytes: 200 * 1024 * 1024,
        maxPages: 200,
        options: {
          ocr: false,
          include_image_base64: true,
          formula: true,
          table: true,
          output_format: "md"
        }
      }
    },
    defaultOptions: {
      language: "ch",
      ocr: false,
      include_image_base64: false,
      formula: true,
      table: true,
      output_format: "md"
    },
    accounts: []
  }
};

function deepMerge(base, override) {
  if (!override || typeof override !== "object" || Array.isArray(override)) return base;
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      out[key] = deepMerge(base[key] ?? {}, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function readJsonIfExists(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return {};
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function envAccounts() {
  const raw = process.env.MINERU_ACCOUNTS_JSON;
  if (!raw) return null;
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("MINERU_ACCOUNTS_JSON must be a JSON array");
  }
  return parsed;
}

export function loadConfig() {
  const configPath = process.env.CONFIG_PATH || path.resolve("config.json");
  const fileConfig = readJsonIfExists(configPath);
  const config = deepMerge(defaultConfig, fileConfig);
  config.configPath = configPath;

  config.server.host = process.env.HOST || config.server.host;
  config.server.port = Number(process.env.PORT || config.server.port);
  config.server.maxRequestBytes = Number(process.env.MAX_REQUEST_BYTES || config.server.maxRequestBytes);

  const dataDir = process.env.DATA_DIR;
  if (dataDir && (!fileConfig.gateway || !fileConfig.gateway.cacheDir)) {
    config.gateway.cacheDir = path.join(dataDir, "cache");
  }

  const accountsFromEnv = envAccounts();
  if (accountsFromEnv) {
    config.mineru.accounts = accountsFromEnv;
  }

  config.gateway.defaultMode = normalizeMode(config.gateway.defaultMode);
  config.mineru.accounts = normalizeAccounts(config, config.mineru.accounts);

  return config;
}

export function normalizeMode(mode) {
  return mode === "precision" ? "precision" : "flash";
}

export function normalizeAccounts(config, accounts) {
  return (accounts || []).map((account, index) => {
    const mode = normalizeMode(account.mode || config.gateway.defaultMode);
    const modeConfig = config.mineru.modes?.[mode] || {};
    return {
      id: account.id || `mineru-${index + 1}`,
      name: account.name || account.id || `MinerU ${index + 1}`,
      apiKey: account.apiKey || account.api_key || process.env[`MINERU_API_KEY_${index + 1}`] || "",
      baseUrl: account.baseUrl || account.base_url || config.mineru.defaultBaseUrl,
      mode,
      endpoint: account.endpoint || modeConfig.endpoint,
      resultEndpoint: account.resultEndpoint || modeConfig.resultEndpoint,
      requestUrl: account.requestUrl || account.request_url || modeConfig.requestUrl || buildUrl(account.baseUrl || account.base_url || config.mineru.defaultBaseUrl, account.endpoint || modeConfig.endpoint),
      resultUrlTemplate: account.resultUrlTemplate || account.result_url_template || modeConfig.resultUrlTemplate || buildUrl(account.baseUrl || account.base_url || config.mineru.defaultBaseUrl, account.resultEndpoint || modeConfig.resultEndpoint),
      tokenRequired: account.tokenRequired ?? modeConfig.tokenRequired ?? mode === "precision",
      maxFileBytes: Number(account.maxFileBytes ?? modeConfig.maxFileBytes ?? 0),
      maxPages: Number(account.maxPages ?? modeConfig.maxPages ?? 0),
      model: account.model || modeConfig.model || config.mineru.defaultModel,
      enabled: account.enabled !== false,
      priority: Number(account.priority ?? 100),
      maxConcurrency: Math.max(1, Number(account.maxConcurrency ?? account.max_concurrency ?? 1)),
      submitPerMinute: Math.max(1, Number(account.submitPerMinute ?? account.submit_per_minute ?? 45)),
      cooldownSeconds: Math.max(1, Number(account.cooldownSeconds ?? account.cooldown_seconds ?? 60)),
      options: { ...config.mineru.defaultOptions, ...(modeConfig.options || {}), ...(account.options || {}) }
    };
  });
}

export function publicConfig(config) {
  return {
    model: config.gateway.model,
    defaultMode: config.gateway.defaultMode,
    modes: config.mineru.modes,
    accounts: config.mineru.accounts.map((account) => ({
      ...account,
      apiKey: undefined,
      apiKeySet: Boolean(account.apiKey)
    }))
  };
}

export async function saveConfig(config) {
  const filePath = config.configPath || path.resolve("config.json");
  const serializable = {
    server: config.server,
    gateway: config.gateway,
    mineru: {
      defaultBaseUrl: config.mineru.defaultBaseUrl,
      defaultModel: config.mineru.defaultModel,
      modes: config.mineru.modes,
      defaultOptions: config.mineru.defaultOptions,
      accounts: config.mineru.accounts.map((account) => ({
        id: account.id,
        name: account.name,
        apiKey: account.apiKey,
        baseUrl: account.baseUrl,
        mode: account.mode,
        endpoint: account.endpoint,
        resultEndpoint: account.resultEndpoint,
        requestUrl: account.requestUrl,
        resultUrlTemplate: account.resultUrlTemplate,
        tokenRequired: account.tokenRequired,
        maxFileBytes: account.maxFileBytes,
        maxPages: account.maxPages,
        model: account.model,
        enabled: account.enabled,
        priority: account.priority,
        maxConcurrency: account.maxConcurrency,
        submitPerMinute: account.submitPerMinute,
        cooldownSeconds: account.cooldownSeconds,
        options: account.options
      }))
    }
  };
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, JSON.stringify(serializable, null, 2));
}

function buildUrl(baseUrl, endpoint) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  const pathPart = String(endpoint || "");
  if (/^https?:\/\//i.test(pathPart)) return pathPart;
  return `${base}${pathPart.startsWith("/") ? "" : "/"}${pathPart}`;
}
