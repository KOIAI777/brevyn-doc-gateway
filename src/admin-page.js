export function adminPageHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Brevyn Doc Gateway</title>
  <style>
    :root {
      color-scheme: light;
      --ink: #17211b;
      --muted: #6b766f;
      --paper: #f4f1e8;
      --card: #fffaf0;
      --line: #ded6c5;
      --line-strong: #c6baa6;
      --blue: #3f74d8;
      --green: #227a57;
      --amber: #a56716;
      --red: #b23b35;
      --shadow: 0 22px 60px rgba(39, 33, 21, 0.11);
      --mono: "SFMono-Regular", "Menlo", "Consolas", monospace;
      --sans: "Avenir Next", "Segoe UI", "Helvetica Neue", sans-serif;
      font-family: var(--sans);
      background: var(--paper);
      color: var(--ink);
    }

    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background:
        radial-gradient(circle at 8% 12%, rgba(63, 116, 216, 0.16), transparent 28rem),
        radial-gradient(circle at 92% 8%, rgba(34, 122, 87, 0.14), transparent 24rem),
        linear-gradient(135deg, #f7f2e7 0%, #eee8d9 100%);
    }

    .shell {
      width: min(1180px, calc(100vw - 36px));
      margin: 0 auto;
      padding: 30px 0 42px;
    }

    header {
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      gap: 18px;
      margin-bottom: 22px;
    }

    h1 {
      margin: 0;
      font-size: clamp(28px, 4vw, 48px);
      line-height: 0.95;
      letter-spacing: -0.055em;
      font-weight: 780;
    }

    .subtitle {
      margin-top: 10px;
      color: var(--muted);
      max-width: 620px;
      line-height: 1.55;
      font-size: 14px;
    }

    .actions {
      display: flex;
      gap: 10px;
      align-items: center;
      flex-wrap: wrap;
      justify-content: flex-end;
    }

    button {
      border: 1px solid var(--line-strong);
      background: #fffaf2;
      color: var(--ink);
      border-radius: 999px;
      padding: 9px 14px;
      font: 700 13px var(--sans);
      cursor: pointer;
      transition: transform 160ms ease, border-color 160ms ease, background 160ms ease;
    }

    button:hover {
      transform: translateY(-1px);
      border-color: #9b8c72;
      background: #fffdf7;
    }

    button.danger {
      color: var(--red);
      border-color: rgba(178, 59, 53, 0.28);
      background: rgba(178, 59, 53, 0.06);
    }

    .grid {
      display: grid;
      grid-template-columns: 0.84fr 1.52fr 0.9fr;
      gap: 16px;
      align-items: start;
    }

    .dashboard {
      display: grid;
      grid-template-columns: repeat(6, minmax(0, 1fr));
      gap: 12px;
      margin-bottom: 16px;
    }

    .card {
      background: color-mix(in srgb, var(--card), white 36%);
      border: 1px solid rgba(104, 91, 65, 0.2);
      box-shadow: var(--shadow);
      border-radius: 26px;
      overflow: hidden;
      backdrop-filter: blur(14px);
    }

    .card-head {
      padding: 18px 18px 12px;
      border-bottom: 1px solid rgba(104, 91, 65, 0.15);
    }

    .card-title {
      margin: 0;
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: 0.14em;
      color: #786c58;
      font-weight: 800;
    }

    .card-body { padding: 18px; }

    .stat {
      padding: 16px;
      min-height: 116px;
      position: relative;
      isolation: isolate;
    }

    .stat::after {
      content: "";
      position: absolute;
      inset: auto 12px 12px auto;
      width: 42px;
      height: 42px;
      border-radius: 50%;
      background: color-mix(in srgb, var(--stat-color, var(--blue)), transparent 78%);
      z-index: -1;
    }

    .stat-label {
      color: var(--muted);
      font-size: 12px;
      font-weight: 800;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }

    .stat-value {
      margin-top: 14px;
      font-size: 28px;
      font-weight: 820;
      letter-spacing: -0.05em;
    }

    .stat-note {
      margin-top: 7px;
      color: var(--muted);
      font: 12px var(--mono);
    }

    .metric {
      display: grid;
      gap: 6px;
      padding: 13px 0;
      border-bottom: 1px dashed rgba(104, 91, 65, 0.2);
    }

    .metric:last-child { border-bottom: 0; }

    .label {
      color: var(--muted);
      font-size: 12px;
      letter-spacing: 0.04em;
    }

    .value {
      font: 750 22px/1.1 var(--sans);
      letter-spacing: -0.03em;
      overflow-wrap: anywhere;
    }

    .value.small {
      font: 650 13px/1.45 var(--mono);
      letter-spacing: -0.01em;
    }

    .pool {
      display: grid;
      gap: 10px;
    }

    .account {
      display: grid;
      grid-template-columns: minmax(160px, 1fr) auto;
      gap: 12px;
      align-items: center;
      padding: 14px;
      border: 1px solid rgba(104, 91, 65, 0.18);
      border-radius: 18px;
      background: rgba(255, 253, 246, 0.72);
    }

    .account-main {
      min-width: 0;
    }

    .account-name {
      font-weight: 760;
      letter-spacing: -0.02em;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .account-meta {
      margin-top: 5px;
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      color: var(--muted);
      font: 12px var(--mono);
    }

    .pills {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }

    .pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      border-radius: 999px;
      padding: 5px 8px;
      font: 700 11px var(--sans);
      background: #efe7d5;
      color: #6f5d3b;
    }

    .pill.ok { background: rgba(34, 122, 87, 0.12); color: var(--green); }
    .pill.warn { background: rgba(165, 103, 22, 0.12); color: var(--amber); }
    .pill.bad { background: rgba(178, 59, 53, 0.12); color: var(--red); }
    .pill.blue { background: rgba(63, 116, 216, 0.13); color: #285fbf; }

    .account-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 10px;
    }

    .bar {
      height: 8px;
      border-radius: 999px;
      background: #e8dfcd;
      overflow: hidden;
      margin-top: 10px;
    }

    .bar span {
      display: block;
      height: 100%;
      width: var(--w, 0%);
      background: linear-gradient(90deg, var(--blue), #1d8f6c);
      border-radius: inherit;
    }

    pre {
      margin: 0;
      white-space: pre-wrap;
      word-break: break-word;
      background: #1d211d;
      color: #e9f1df;
      border-radius: 18px;
      padding: 14px;
      font: 12px/1.6 var(--mono);
      max-height: 340px;
      overflow: auto;
    }

    .hint {
      color: var(--muted);
      font-size: 13px;
      line-height: 1.55;
    }

    .empty {
      border: 1px dashed var(--line-strong);
      border-radius: 18px;
      padding: 22px;
      color: var(--muted);
      background: rgba(255, 253, 246, 0.6);
    }

    .events {
      display: grid;
      gap: 8px;
      max-height: 280px;
      overflow: auto;
      padding-right: 2px;
    }

    .event {
      display: grid;
      gap: 5px;
      padding: 10px 11px;
      border-radius: 14px;
      background: rgba(255, 253, 246, 0.66);
      border: 1px solid rgba(104, 91, 65, 0.15);
    }

    .event-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      font-size: 12px;
      color: var(--muted);
    }

    .event-type {
      font-weight: 850;
      color: var(--blue);
      letter-spacing: 0.02em;
    }

    .event-message {
      font: 12px/1.45 var(--mono);
      color: var(--ink);
      overflow-wrap: anywhere;
    }

    .form {
      margin-top: 16px;
      padding-top: 16px;
      border-top: 1px solid rgba(104, 91, 65, 0.15);
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
    }

    .form h3 {
      grid-column: 1 / -1;
      margin: 0 0 4px;
      font-size: 15px;
      letter-spacing: -0.02em;
    }

    .field {
      display: grid;
      gap: 6px;
    }

    .field.full {
      grid-column: 1 / -1;
    }

    .field label {
      color: var(--muted);
      font-size: 12px;
      font-weight: 750;
    }

    input, select {
      width: 100%;
      border: 1px solid rgba(104, 91, 65, 0.26);
      background: rgba(255, 253, 246, 0.82);
      color: var(--ink);
      border-radius: 13px;
      padding: 10px 11px;
      font: 13px var(--sans);
      outline: none;
    }

    input:focus, select:focus {
      border-color: rgba(63, 116, 216, 0.72);
      box-shadow: 0 0 0 3px rgba(63, 116, 216, 0.12);
    }

    .switch-row {
      grid-column: 1 / -1;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 10px 0;
    }

    .form-actions {
      grid-column: 1 / -1;
      display: flex;
      gap: 10px;
      justify-content: flex-end;
    }

    @media (max-width: 1020px) {
      .dashboard { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .grid { grid-template-columns: 1fr; }
      header { align-items: flex-start; flex-direction: column; }
      .actions { justify-content: flex-start; }
    }
  </style>
</head>
<body>
  <main class="shell">
    <header>
      <div>
        <h1>Doc Gateway<br/>Control Room</h1>
        <div class="subtitle">文档解析网关状态台。这里负责把 sub2api 的 OpenAI-compatible 请求转成 MinerU 异步解析任务，并管理账号池、限流、冷却和缓存。</div>
      </div>
      <div class="actions">
        <button id="refresh">刷新状态</button>
        <button id="probe">探测上游</button>
      </div>
    </header>

    <section class="dashboard" id="dashboard"></section>

    <section class="grid">
      <aside class="card">
        <div class="card-head"><h2 class="card-title">Service</h2></div>
        <div class="card-body" id="service"></div>
      </aside>

      <section class="card">
        <div class="card-head"><h2 class="card-title">MinerU Account Pool</h2></div>
        <div class="card-body">
          <div class="pool" id="accounts"></div>
          <form class="form" id="account-form">
            <h3>添加 / 更新账号</h3>
            <div class="field">
              <label for="account-id">账号 ID</label>
              <input id="account-id" name="id" placeholder="mineru-a" required />
            </div>
            <div class="field">
              <label for="account-name">显示名称</label>
              <input id="account-name" name="name" placeholder="MinerU Account A" />
            </div>
            <div class="field full">
              <label for="account-key">API Key</label>
              <input id="account-key" name="apiKey" type="password" placeholder="快速模式可留空；精细模式需要 token；更新时留空保留原 key" autocomplete="off" />
            </div>
            <div class="field full">
              <label for="account-request-url">完整请求地址</label>
              <input id="account-request-url" name="requestUrl" value="https://mineru.net/api/v1/agent/parse/file" />
            </div>
            <div class="field full">
              <label for="account-result-url">轮询地址模板</label>
              <input id="account-result-url" name="resultUrlTemplate" value="https://mineru.net/api/v1/agent/parse/{task_id}" />
            </div>
            <div class="field">
              <label for="account-mode">解析模式</label>
              <select id="account-mode" name="mode">
                <option value="flash">快速模式 Flash</option>
                <option value="precision">精细模式 Precision</option>
              </select>
            </div>
            <div class="field">
              <label for="account-model">上游模型</label>
              <input id="account-model" name="model" value="vlm" />
            </div>
            <div class="field">
              <label for="account-priority">优先级</label>
              <input id="account-priority" name="priority" type="number" value="10" />
            </div>
            <div class="field">
              <label for="account-concurrency">最大并发</label>
              <input id="account-concurrency" name="maxConcurrency" type="number" value="1" min="1" />
            </div>
            <div class="field">
              <label for="account-rpm">每分钟提交</label>
              <input id="account-rpm" name="submitPerMinute" type="number" value="45" min="1" />
            </div>
            <div class="field">
              <label for="account-cooldown">失败冷却秒</label>
              <input id="account-cooldown" name="cooldownSeconds" type="number" value="60" min="1" />
            </div>
            <div class="switch-row">
              <label><input id="account-enabled" name="enabled" type="checkbox" checked style="width:auto; margin-right: 8px;" />启用这个账号</label>
              <span class="hint">快速无 token；精细走 extract API，需要 token。</span>
            </div>
            <div class="form-actions">
              <button type="button" id="clear-form">清空</button>
              <button type="submit">保存账号</button>
            </div>
          </form>
        </div>
      </section>

      <aside class="card">
        <div class="card-head"><h2 class="card-title">Diagnostics</h2></div>
        <div class="card-body">
          <div class="hint" style="margin-bottom: 12px;">探测只检查上游连通和基础鉴权，不会提交解析任务，也不会消耗文档解析额度。</div>
          <pre id="diagnostics">等待探测...</pre>
          <div style="height: 14px;"></div>
          <div class="card-title" style="margin-bottom: 10px;">Recent Events</div>
          <div class="events" id="events"></div>
        </div>
      </aside>
    </section>
  </main>

  <script>
    let adminKey = localStorage.getItem("brevyn_doc_gateway_admin_key") || "";
    let latestConfig = null;

    function authHeaders() {
      return adminKey ? { Authorization: "Bearer " + adminKey } : {};
    }

    async function requestJson(path, options = {}) {
      const res = await fetch(path, {
        ...options,
        headers: {
          ...authHeaders(),
          ...(options.headers || {})
        }
      });
      if (res.status === 401) {
        adminKey = prompt("请输入 ADMIN_API_KEY 或 GATEWAY_API_KEY") || "";
        localStorage.setItem("brevyn_doc_gateway_admin_key", adminKey);
        return requestJson(path, options);
      }
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error?.message || JSON.stringify(json));
      return json;
    }

    function fmtMs(ms) {
      if (!ms) return "0s";
      if (ms < 1000) return ms + "ms";
      if (ms < 60000) return Math.ceil(ms / 1000) + "s";
      return Math.ceil(ms / 60000) + "m";
    }

    function pct(active, max) {
      if (!max) return 0;
      return Math.min(100, Math.round((active / max) * 100));
    }

    function renderService(status) {
      document.getElementById("service").innerHTML = [
        ["模型", status.model],
        ["运行时间", fmtMs(status.uptime_ms)],
        ["缓存", status.cache.enabled ? "已启用" : "未启用"],
        ["缓存目录", status.cache.dir],
        ["账号数量", String(status.accounts.length)]
      ].map(([label, value], index) => \`
        <div class="metric">
          <div class="label">\${label}</div>
          <div class="value \${index === 3 ? "small" : ""}">\${escapeHtml(value)}</div>
        </div>
      \`).join("");
    }

    function renderDashboard(status) {
      const metrics = status.metrics || {};
      const activeAccounts = status.accounts.filter((account) => account.enabled && account.cooldownMsRemaining === 0).length;
      const totalAccounts = status.accounts.length;
      const stats = [
        ["解析请求", metrics.total_parse_requests ?? 0, "总入口请求", "var(--blue)"],
        ["成功", metrics.successes ?? 0, "含缓存命中", "var(--green)"],
        ["失败", metrics.failures ?? 0, "最终失败", "var(--red)"],
        ["缓存命中", metrics.cache_hits ?? 0, "磁盘缓存", "var(--amber)"],
        ["上游尝试", metrics.upstream_attempts ?? 0, "MinerU submit", "var(--blue)"],
        ["账号可用", activeAccounts + "/" + totalAccounts, "未冷却且启用", "var(--green)"]
      ];
      document.getElementById("dashboard").innerHTML = stats.map(([label, value, note, color]) => \`
        <article class="card stat" style="--stat-color:\${color}">
          <div class="stat-label">\${escapeHtml(label)}</div>
          <div class="stat-value">\${escapeHtml(value)}</div>
          <div class="stat-note">\${escapeHtml(note)}</div>
        </article>
      \`).join("");
      renderEvents(metrics.recent_events || []);
    }

    function renderEvents(events) {
      const root = document.getElementById("events");
      if (!events.length) {
        root.innerHTML = '<div class="empty" style="padding: 14px;">暂无解析事件。</div>';
        return;
      }
      root.innerHTML = events.map((event) => \`
        <article class="event">
          <div class="event-top">
            <span class="event-type">\${escapeHtml(event.type)}</span>
            <span>\${escapeHtml(new Date(event.at).toLocaleTimeString())}</span>
          </div>
          <div class="event-message">\${escapeHtml(event.file || event.account_id || "")} \${escapeHtml(event.message || event.task_id || "")}</div>
        </article>
      \`).join("");
    }

    function renderAccounts(accounts) {
      const root = document.getElementById("accounts");
      if (!accounts.length) {
        root.innerHTML = '<div class="empty">还没有配置可用 MinerU 账号。可以直接在下面添加 API Key，配置会保存到 gateway 的 config.json。</div>';
        return;
      }
      root.innerHTML = accounts.map((account) => {
        const load = pct(account.active, account.maxConcurrency);
        const disabled = !account.enabled;
        const cooling = account.cooldownMsRemaining > 0;
        return \`
          <article class="account">
            <div class="account-main">
              <div class="account-name">\${escapeHtml(account.name || account.id)}</div>
              <div class="account-meta">
                <span>id=\${escapeHtml(account.id)}</span>
                <span>mode=\${escapeHtml(account.mode || "flash")}</span>
                <span>model=\${escapeHtml(account.model || "")}</span>
                <span>url=\${escapeHtml(account.requestUrl || account.baseUrl || "")}</span>
                <span>priority=\${account.priority}</span>
                <span>success=\${account.successes}</span>
                <span>fail=\${account.failures}</span>
              </div>
              <div class="bar" title="active / max concurrency">
                <span style="--w:\${load}%"></span>
              </div>
            </div>
            <div class="pills">
              <span class="pill \${disabled ? "bad" : "ok"}">\${disabled ? "停用" : "启用"}</span>
              <span class="pill \${account.mode === "precision" ? "warn" : "ok"}">\${account.mode === "precision" ? "精细" : "快速"}</span>
              <span class="pill blue">\${account.active}/\${account.maxConcurrency}</span>
              <span class="pill">rpm \${account.submitPerMinute}</span>
              \${cooling ? \`<span class="pill warn">冷却 \${fmtMs(account.cooldownMsRemaining)}</span>\` : ""}
              <div class="account-actions">
                <button type="button" data-edit="\${escapeHtml(account.id)}">编辑</button>
                <button type="button" class="danger" data-delete="\${escapeHtml(account.id)}">删除</button>
              </div>
            </div>
          </article>
        \`;
      }).join("");

      root.querySelectorAll("[data-edit]").forEach((button) => {
        button.addEventListener("click", () => fillForm(button.dataset.edit));
      });
      root.querySelectorAll("[data-delete]").forEach((button) => {
        button.addEventListener("click", () => deleteAccount(button.dataset.delete));
      });
    }

    async function refresh() {
      const [status, config] = await Promise.all([
        requestJson("/api/admin/status"),
        requestJson("/api/admin/config")
      ]);
      latestConfig = config;
      renderDashboard(status);
      renderService(status);
      renderAccounts(status.accounts);
    }

    async function probe() {
      const out = document.getElementById("diagnostics");
      out.textContent = "探测中...";
      try {
        const result = await requestJson("/api/admin/probe", { method: "POST" });
        out.textContent = JSON.stringify(result, null, 2);
        await refresh();
      } catch (error) {
        out.textContent = error.message;
      }
    }

    function fillForm(id) {
      const account = latestConfig?.accounts?.find((item) => item.id === id);
      if (!account) return;
      const form = document.getElementById("account-form");
      const fields = form.elements;
      fields.id.value = account.id;
      fields.name.value = account.name || "";
      fields.apiKey.value = "";
      fields.requestUrl.value = account.requestUrl || "https://mineru.net/api/v1/agent/parse/file";
      fields.resultUrlTemplate.value = account.resultUrlTemplate || "https://mineru.net/api/v1/agent/parse/{task_id}";
      fields.mode.value = account.mode || "flash";
      fields.model.value = account.model || (account.mode === "precision" ? "vlm" : "pipeline");
      fields.priority.value = account.priority ?? 10;
      fields.maxConcurrency.value = account.maxConcurrency ?? 1;
      fields.submitPerMinute.value = account.submitPerMinute ?? 45;
      fields.cooldownSeconds.value = account.cooldownSeconds ?? 60;
      fields.enabled.checked = account.enabled !== false;
    }

    function clearForm() {
      const form = document.getElementById("account-form");
      const fields = form.elements;
      form.reset();
      fields.id.value = "";
      fields.name.value = "";
      fields.apiKey.value = "";
      fields.requestUrl.value = "https://mineru.net/api/v1/agent/parse/file";
      fields.resultUrlTemplate.value = "https://mineru.net/api/v1/agent/parse/{task_id}";
      fields.mode.value = "flash";
      fields.model.value = "pipeline";
      fields.priority.value = 10;
      fields.maxConcurrency.value = 1;
      fields.submitPerMinute.value = 45;
      fields.cooldownSeconds.value = 60;
      fields.enabled.checked = true;
    }

    async function saveAccount(event) {
      event.preventDefault();
      const form = event.currentTarget;
      const fields = form.elements;
      const body = {
        id: fields.id.value.trim(),
        name: fields.name.value.trim(),
        apiKey: fields.apiKey.value.trim(),
        requestUrl: fields.requestUrl.value.trim(),
        resultUrlTemplate: fields.resultUrlTemplate.value.trim(),
        mode: fields.mode.value,
        model: fields.model.value.trim(),
        enabled: fields.enabled.checked,
        priority: Number(fields.priority.value || 10),
        maxConcurrency: Number(fields.maxConcurrency.value || 1),
        submitPerMinute: Number(fields.submitPerMinute.value || 45),
        cooldownSeconds: Number(fields.cooldownSeconds.value || 60)
      };
      await requestJson("/api/admin/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      document.getElementById("diagnostics").textContent = "账号已保存：" + body.id;
      clearForm();
      await refresh();
    }

    async function deleteAccount(id) {
      if (!confirm("删除账号 " + id + "？")) return;
      await requestJson("/api/admin/accounts/" + encodeURIComponent(id), { method: "DELETE" });
      document.getElementById("diagnostics").textContent = "账号已删除：" + id;
      await refresh();
    }

    function escapeHtml(value) {
      return String(value ?? "").replace(/[&<>"']/g, (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      }[char]));
    }

    document.getElementById("refresh").addEventListener("click", refresh);
    document.getElementById("probe").addEventListener("click", probe);
    document.getElementById("account-form").addEventListener("submit", saveAccount);
    document.getElementById("clear-form").addEventListener("click", clearForm);
    document.getElementById("account-mode").addEventListener("change", (event) => {
      const form = document.getElementById("account-form");
      const precision = event.target.value === "precision";
      form.elements.model.value = precision ? "vlm" : "pipeline";
      form.elements.requestUrl.value = precision ? "https://mineru.net/api/v4/file-urls/batch" : "https://mineru.net/api/v1/agent/parse/file";
      form.elements.resultUrlTemplate.value = precision ? "https://mineru.net/api/v4/extract-results/batch/{task_id}" : "https://mineru.net/api/v1/agent/parse/{task_id}";
    });
    refresh().catch((error) => {
      document.getElementById("diagnostics").textContent = error.message;
    });
  </script>
</body>
</html>`;
}
