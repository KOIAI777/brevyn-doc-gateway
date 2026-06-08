import AdmZip from "adm-zip";
import { normalizeBaseUrl, sleep } from "./util.js";

const successStatuses = new Set(["success", "succeeded", "completed", "done"]);
const failureStatuses = new Set(["failed", "error", "cancelled", "canceled"]);

export class MinerUClient {
  constructor({ requestTimeoutMs, pollIntervalMs, pollTimeoutMs }) {
    this.requestTimeoutMs = requestTimeoutMs;
    this.pollIntervalMs = pollIntervalMs;
    this.pollTimeoutMs = pollTimeoutMs;
  }

  async parse({ account, file, options, signal }) {
    this.#validateAccountRequest({ account, file });
    const submit = await this.#submitTask({ account, file, options, signal });
    const task = await this.#pollTask({ account, submit, signal });
    const markdown = await this.#extractMarkdown({ account, task, signal });
    if (!markdown || !markdown.trim()) {
      throw new Error("MinerU result did not contain markdown text");
    }
    return {
      markdown,
      task,
      taskId: submit.task_id || submit.id || task.task_id || task.id || ""
    };
  }

  async #submitTask({ account, file, options, signal }) {
    if (account.requestUrl?.includes("/async/documents/parse")) {
      return this.#submitMultipartTask({ account, file, options, signal });
    }
    if (account.mode === "precision") {
      return this.#submitPrecisionBatchTask({ account, file, options, signal });
    }
    return this.#submitFlashTask({ account, file, options, signal });
  }

  async #submitMultipartTask({ account, file, options, signal }) {
    const form = new FormData();
    form.set("file", new Blob([file.buffer], { type: file.mediaType }), file.filename);
    for (const [key, value] of Object.entries(buildMinerUParams(account, options))) {
      if (value === undefined || value === null || value === "") continue;
      form.set(key, String(value));
    }

    const headers = {};
    if (account.apiKey) {
      headers.Authorization = `Bearer ${account.apiKey}`;
    }
    const response = await fetchWithTimeout(account.requestUrl, {
      method: "POST",
      headers,
      body: form,
      signal
    }, this.requestTimeoutMs);

    const body = await readJsonResponse(response);
    if (!response.ok) {
      throw httpError(response.status, body);
    }
    if (!body.task_id && !body.id && !body.urls?.get) {
      throw new Error("MinerU submit response is missing task_id/urls.get");
    }
    return body;
  }

  async #submitFlashTask({ account, file, options, signal }) {
    const params = buildMinerUParams(account, options);
    const submitBody = {
      file_name: file.filename,
      language: params.language,
      is_ocr: params.is_ocr,
      enable_formula: params.enable_formula,
      enable_table: params.enable_table,
      page_range: params.page_range
    };
    const submit = await this.#postJson(account.requestUrl, account, submitBody, signal);
    const uploadUrl = submit.file_url || submit.upload_url || submit.url || submit.urls?.upload;
    if (!uploadUrl) {
      throw new Error("MinerU flash submit response is missing file_url");
    }
    await uploadFile(uploadUrl, file, signal, this.requestTimeoutMs);
    return submit;
  }

  async #submitPrecisionBatchTask({ account, file, options, signal }) {
    const params = buildMinerUParams(account, options);
    const dataId = file.sha256 || file.filename;
    const submitBody = {
      files: [{ name: file.filename, data_id: dataId }],
      model_version: account.model,
      language: params.language,
      enable_formula: params.formula,
      enable_table: params.table,
      ocr: params.ocr,
      pages: params.pages
    };
    const submit = await this.#postJson(account.requestUrl, account, submitBody, signal);
    const uploadUrl = submit.file_urls?.[0]?.url || submit.file_urls?.[0]?.file_url || submit.urls?.[0] || submit.file_url || submit.upload_url;
    if (!uploadUrl) {
      throw new Error("MinerU precision submit response is missing upload URL");
    }
    await uploadFile(uploadUrl, file, signal, this.requestTimeoutMs);
    return {
      ...submit,
      task_id: submit.batch_id || submit.task_id || submit.id || dataId
    };
  }

  async #postJson(url, account, body, signal) {
    const headers = { "Content-Type": "application/json" };
    if (account.apiKey) {
      headers.Authorization = `Bearer ${account.apiKey}`;
    }
    const response = await fetchWithTimeout(url, {
      method: "POST",
      headers,
      body: JSON.stringify(stripEmpty(body)),
      signal
    }, this.requestTimeoutMs);
    const json = await readJsonResponse(response);
    if (!response.ok) {
      throw httpError(response.status, json);
    }
    return json;
  }

  async #pollTask({ account, submit, signal }) {
    const startedAt = Date.now();
    let latest = submit;
    while (Date.now() - startedAt < this.pollTimeoutMs) {
      const status = String(latest.status || "").toLowerCase();
      if (successStatuses.has(status) || hasInlineResult(latest)) return latest;
      if (failureStatuses.has(status)) {
        throw new Error(`MinerU task failed: ${latest.error || latest.message || status}`);
      }

      await sleep(this.pollIntervalMs, signal);
      latest = await this.#getTask({ account, submit, signal });
    }
    throw new Error(`MinerU task timed out after ${this.pollTimeoutMs}ms`);
  }

  async #getTask({ account, submit, signal }) {
    const taskId = submit.task_id || submit.taskId || submit.id;
    const url = submit.urls?.get || submit.get_url || buildResultUrl(account, taskId);
    const headers = {};
    if (account.apiKey) {
      headers.Authorization = `Bearer ${account.apiKey}`;
    }
    const response = await fetchWithTimeout(url, {
      method: "GET",
      headers,
      signal
    }, this.requestTimeoutMs);
    const body = await readJsonResponse(response);
    if (!response.ok) {
      throw httpError(response.status, body);
    }
    return body;
  }

  async #extractMarkdown({ account, task, signal }) {
    const direct = findMarkdown(task);
    if (direct) return direct;

    const zipUrl = findZipUrl(task);
    if (zipUrl) {
      const response = await fetchWithTimeout(zipUrl, {
        method: "GET",
        headers: zipUrl.includes(normalizeBaseUrl(account.baseUrl)) ? authHeaders(account) : {},
        signal
      }, this.requestTimeoutMs);
      if (!response.ok) {
        throw httpError(response.status, await response.text());
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      return markdownFromZip(buffer);
    }

    const markdownUrl = findMarkdownUrl(task);
    if (markdownUrl) {
      const response = await fetchWithTimeout(markdownUrl, {
        method: "GET",
        headers: markdownUrl.includes(normalizeBaseUrl(account.baseUrl)) ? authHeaders(account) : {},
        signal
      }, this.requestTimeoutMs);
      if (!response.ok) {
        throw httpError(response.status, await response.text());
      }
      return response.text();
    }

    return "";
  }

  #validateAccountRequest({ account, file }) {
    if (account.tokenRequired && !account.apiKey) {
      throw new Error(`${account.mode} mode requires MinerU token`);
    }
    if (account.maxFileBytes > 0 && file.buffer.length > account.maxFileBytes) {
      throw new Error(`${account.mode} mode file limit exceeded: ${file.buffer.length} > ${account.maxFileBytes} bytes`);
    }
  }
}

function buildMinerUParams(account, options) {
  const merged = { ...account.options, ...options };
  const mode = account.mode === "precision" ? "precision" : "flash";
  if (mode === "flash") {
    return {
      language: merged.language,
      is_ocr: merged.ocr ?? merged.is_ocr ?? false,
      enable_formula: merged.formula ?? merged.enable_formula ?? true,
      enable_table: merged.table ?? merged.enable_table ?? true,
      page_range: merged.page_range ?? merged.pages,
      output_format: merged.output_format
    };
  }
  return {
    model: account.model,
    language: merged.language,
    ocr: merged.ocr ?? false,
    formula: merged.formula ?? true,
    table: merged.table ?? true,
    pages: merged.pages ?? merged.page_range,
    output_format: merged.output_format
  };
}

function buildResultUrl(account, taskId) {
  if (!taskId) {
    throw new Error("MinerU submit response is missing result URL and task_id");
  }
  const template = account.resultUrlTemplate || account.resultEndpoint || "";
  if (!template) {
    throw new Error("MinerU account is missing resultEndpoint");
  }
  const path = template.replace("{task_id}", encodeURIComponent(taskId));
  return `${normalizeBaseUrl(account.baseUrl)}${path}`;
}

function authHeaders(account) {
  return account.apiKey ? { Authorization: `Bearer ${account.apiKey}` } : {};
}

async function uploadFile(uploadUrl, file, signal, timeoutMs) {
  const response = await fetchWithTimeout(uploadUrl, {
    method: "PUT",
    headers: file.mediaType ? { "Content-Type": file.mediaType } : {},
    body: file.buffer,
    signal
  }, timeoutMs);
  if (!response.ok) {
    throw httpError(response.status, await response.text());
  }
}

function stripEmpty(value) {
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined || item === null || item === "") continue;
    out[key] = item;
  }
  return out;
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const upstreamSignal = init.signal;
  const timeout = setTimeout(() => controller.abort(new Error(`Request timeout after ${timeoutMs}ms`)), timeoutMs);
  const abortUpstream = () => controller.abort(upstreamSignal.reason ?? new Error("Aborted"));
  if (upstreamSignal) upstreamSignal.addEventListener("abort", abortUpstream, { once: true });
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
    if (upstreamSignal) upstreamSignal.removeEventListener("abort", abortUpstream);
  }
}

async function readJsonResponse(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function httpError(status, body) {
  const message = typeof body === "string"
    ? body
    : body?.error?.message || body?.message || body?.raw || JSON.stringify(body);
  const error = new Error(`HTTP ${status}: ${message}`);
  error.status = status;
  return error;
}

function hasInlineResult(task) {
  return Boolean(findMarkdown(task) || findZipUrl(task) || findMarkdownUrl(task));
}

function findMarkdown(value) {
  const candidates = [
    value?.output_text,
    value?.markdown,
    value?.md,
    value?.result?.markdown,
    value?.result?.md,
    value?.output?.markdown,
    value?.output?.md,
    value?.output?.result?.markdown
  ];
  return candidates.find((item) => typeof item === "string" && item.trim());
}

function findMarkdownUrl(value) {
  const candidates = [
    value?.markdown_url,
    value?.md_url,
    value?.result?.markdown_url,
    value?.output?.markdown_url,
    value?.output?.md_url,
    value?.urls?.markdown,
    value?.urls?.md
  ];
  return candidates.find((item) => typeof item === "string" && item);
}

function findZipUrl(value) {
  const candidates = [
    value?.zip_url,
    value?.result?.zip_url,
    value?.output?.zip_url,
    value?.output?.result_zip_url,
    value?.urls?.download,
    value?.urls?.zip
  ];
  return candidates.find((item) => typeof item === "string" && item);
}

function markdownFromZip(buffer) {
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries()
    .filter((entry) => !entry.isDirectory && entry.entryName.toLowerCase().endsWith(".md"))
    .sort((a, b) => {
      const aPreferred = /(^|\/)(full|result|output|content)\.md$/i.test(a.entryName) ? 0 : 1;
      const bPreferred = /(^|\/)(full|result|output|content)\.md$/i.test(b.entryName) ? 0 : 1;
      if (aPreferred !== bPreferred) return aPreferred - bPreferred;
      return b.header.size - a.header.size;
    });
  if (entries.length === 0) {
    throw new Error("MinerU zip result did not contain a markdown file");
  }
  return entries[0].getData().toString("utf8");
}
