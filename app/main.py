from __future__ import annotations

import base64
import os
import time
import uuid
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse

from .cache import DiskCache, cache_key
from .config import delete_account, load_config, public_config, save_config, upsert_account
from .mineru_sdk import MinerUSDKClient
from .scheduler import AccountScheduler


app = FastAPI(title="Brevyn Doc Gateway")
config = load_config()
save_config(config)
scheduler = AccountScheduler(config.accounts)
cache = DiskCache(config.cache_enabled, config.cache_dir)
mineru = MinerUSDKClient()
started_at = time.time()
metrics = {
    "total_parse_requests": 0,
    "successes": 0,
    "failures": 0,
    "cache_hits": 0,
    "upstream_attempts": 0,
    "failovers": 0,
    "avg_duration_ms": 0,
    "recent_events": [],
}


@app.get("/", response_class=HTMLResponse)
@app.get("/admin", response_class=HTMLResponse)
async def admin() -> str:
    return ADMIN_HTML


@app.get("/healthz")
async def healthz():
    return {"ok": True, "model": config.model, "accounts": scheduler.snapshot()}


@app.get("/v1/models")
async def models(request: Request):
    require_gateway_auth(request)
    return {"object": "list", "data": [{"id": config.model, "object": "model", "owned_by": "brevyn"}]}


@app.get("/api/admin/status")
async def admin_status():
    return {
        "ok": True,
        "model": config.model,
        "uptime_ms": int((time.time() - started_at) * 1000),
        "cache": {"enabled": config.cache_enabled, "dir": config.cache_dir},
        "metrics": metrics,
        "routing": {
            "strategy": "same_mode_priority_active_ratio_lru",
            "summary": "先过滤同模式且启用的账号，再排除缺 token、冷却中、满并发、RPM 用尽的账号；候选账号按优先级、并发占用比例、最近使用时间轮换。",
            "order": ["模式匹配", "账号启用", "precision token 已配置", "不在冷却期", "并发未满", "RPM 未用尽", "优先级更高", "并发占比更低", "更久未使用"],
        },
        "accounts": scheduler.snapshot(),
    }


@app.get("/api/admin/config")
async def admin_config():
    return public_config(config)


@app.post("/api/admin/accounts")
async def admin_upsert_account(request: Request):
    global config, scheduler
    payload = await request.json()
    try:
        config = upsert_account(config, payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    scheduler.replace(config.accounts)
    return public_config(config)


@app.delete("/api/admin/accounts/{account_id}")
async def admin_delete_account(account_id: str):
    global config, scheduler
    config = delete_account(config, account_id)
    scheduler.replace(config.accounts)
    return public_config(config)


@app.post("/api/admin/probe")
async def admin_probe():
    return {
        "checked_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "results": [
            {
                "id": item["id"],
                "name": item["name"],
                "ok": item["enabled"] and (item["mode"] == "flash" or item["tokenRequired"] is False or item.get("apiKeySet", False)),
                "status": "configured" if item["enabled"] else "disabled",
                "latency_ms": 0,
                "message": "SDK mode; no non-consuming upstream request is needed",
            }
            for item in public_config(config)["accounts"]
        ],
    }


@app.post("/api/admin/parse-test")
async def admin_parse_test(request: Request):
    return await run_parse_request(request)


@app.post("/v1/responses")
async def responses(request: Request):
    require_gateway_auth(request)
    return await run_parse_request(request)


async def run_parse_request(request: Request):
    started = time.time()
    metrics["total_parse_requests"] += 1
    body = await request.json()
    model = body.get("model") or config.model
    if model != config.model:
        raise HTTPException(status_code=400, detail=f"Unsupported model: {model}")

    file = extract_input_file(body)
    options = body.get("parse_options") or body.get("document_parse_options") or {}
    mode = options.get("mode") or body.get("mode") or config.default_mode
    if mode not in {"flash", "precision"}:
        mode = "flash"
    options["mode"] = mode
    key = cache_key(file_bytes=file["bytes"], filename=file["filename"], model=model, mode=mode, options=options)
    cached = cache.get(key)
    if cached:
        metrics["cache_hits"] += 1
        metrics["successes"] += 1
        push_event("cache_hit", file=file["filename"], mode=mode)
        return response_body(model=model, output_text=cached["output_text"], metadata={**cached.get("metadata", {}), "cache_hit": True})

    last_error: Exception | None = None
    attempted_accounts: set[str] = set()
    while True:
        lease = scheduler.acquire(mode, exclude=attempted_accounts)
        if lease is None:
            metrics["failures"] += 1
            if last_error is not None:
                raise HTTPException(status_code=502, detail=str(last_error)) from last_error
            raise HTTPException(status_code=503, detail=f"No available MinerU account for mode={mode}")

        account = lease.account()
        attempted_accounts.add(account.id)
        try:
            metrics["upstream_attempts"] += 1
            result = await mineru.parse(
                account=account,
                file_bytes=file["bytes"],
                filename=file["filename"],
                options=options,
                timeout=config.request_timeout_seconds,
            )
            lease.release(True)
            duration = int((time.time() - started) * 1000)
            metrics["successes"] += 1
            update_avg(duration)
            metadata = {**result["metadata"], "cache_hit": False}
            cache.set(key, {"output_text": result["markdown"], "metadata": metadata})
            push_event("parse_success", file=file["filename"], mode=mode, account_id=account.id, duration_ms=duration)
            return response_body(model=model, output_text=result["markdown"], metadata=metadata)
        except Exception as exc:
            lease.release(False)
            last_error = exc
            metrics["failovers"] += 1
            push_event("parse_failed", file=file["filename"], mode=mode, account_id=account.id, message=str(exc))


def extract_input_file(body: dict[str, Any]) -> dict[str, Any]:
    stack = [body.get("input"), body.get("messages"), body.get("content"), body]
    while stack:
        current = stack.pop(0)
        if current is None:
            continue
        if isinstance(current, list):
            stack = current + stack
            continue
        if not isinstance(current, dict):
            continue
        raw = current.get("file_data") or current.get("fileData") or current.get("data")
        if raw:
            if "," in raw and raw.startswith("data:"):
                raw = raw.split(",", 1)[1]
            return {
                "filename": current.get("filename") or current.get("name") or "document",
                "bytes": base64.b64decode(raw),
            }
        if current.get("content") is not None:
            stack.append(current["content"])
        if current.get("file") is not None:
            stack.append(current["file"])
    raise HTTPException(status_code=400, detail="No input_file with file_data was found")


def require_gateway_auth(request: Request) -> None:
    expected = os.environ.get("GATEWAY_API_KEY", "").strip()
    if not expected:
        return
    auth = request.headers.get("authorization", "")
    token = auth.removeprefix("Bearer").strip() if auth.lower().startswith("bearer") else ""
    if token != expected:
        raise HTTPException(status_code=401, detail="Invalid gateway API key")


def response_body(*, model: str, output_text: str, metadata: dict[str, Any]) -> dict[str, Any]:
    response_id = f"resp_{uuid.uuid4().hex}"
    message_id = f"msg_{uuid.uuid4().hex}"
    return {
        "id": response_id,
        "object": "response",
        "created_at": int(time.time()),
        "status": "completed",
        "model": model,
        "output": [
            {
                "id": message_id,
                "type": "message",
                "status": "completed",
                "role": "assistant",
                "content": [
                    {
                        "type": "output_text",
                        "text": output_text,
                        "annotations": [],
                    }
                ],
            }
        ],
        "output_text": output_text,
        "usage": {
            "input_tokens": 0,
            "output_tokens": 0,
            "total_tokens": 0,
        },
        "metadata": metadata,
    }


def push_event(event_type: str, **payload: Any) -> None:
    metrics["recent_events"].insert(0, {"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "type": event_type, **payload})
    del metrics["recent_events"][24:]


def update_avg(duration_ms: int) -> None:
    done = max(1, metrics["successes"] + metrics["failures"])
    current = metrics["avg_duration_ms"]
    metrics["avg_duration_ms"] = int(((current * (done - 1)) + duration_ms) / done)


ADMIN_HTML = """<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Brevyn Doc Gateway</title>
  <style>
    :root{--bg:#f4f1e8;--panel:#fffaf0;--panel-2:#fffdf7;--ink:#17211b;--muted:#6b766f;--line:#ded6c5;--line-2:#c9bea9;--brand:#285fbf;--good:#227a57;--bad:#b23b35;--warn:#9b6a16}
    *{box-sizing:border-box}
    html{scroll-behavior:smooth}
    body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:radial-gradient(circle at 14% 0,#fff8e8 0,#f4f1e8 34%,#ece5d7 100%);color:var(--ink)}
    a{color:inherit;text-decoration:none}
    button,input,select{font:inherit}
    .shell{display:grid;grid-template-columns:240px minmax(0,1fr);min-height:100vh}
    aside{position:sticky;top:0;height:100vh;padding:22px;border-right:1px solid var(--line);background:rgba(255,250,240,.74);backdrop-filter:blur(18px)}
    .brand{display:flex;align-items:center;gap:11px;margin-bottom:28px}
    .logo{width:38px;height:38px;border-radius:14px;background:linear-gradient(135deg,#17211b,#476050);box-shadow:0 12px 30px #17211b24}
    .brand b{display:block;font-size:15px;letter-spacing:-.02em}.brand span{display:block;color:var(--muted);font-size:12px;margin-top:2px}
    nav{display:grid;gap:7px}
    nav a{padding:10px 12px;border-radius:14px;color:#465249;font-size:14px;font-weight:700}
    nav a:hover,nav a.active{background:#efe7d5;color:var(--ink)}
    .side-note{position:absolute;left:22px;right:22px;bottom:22px;padding:13px;border-radius:18px;background:#f7eedb;border:1px solid var(--line);color:var(--muted);font-size:12px;line-height:1.55}
    main{width:min(1220px,calc(100vw - 292px));padding:30px 28px 48px}
    .view{display:none}
    .view.active{display:block}
    .hero{display:flex;justify-content:space-between;gap:18px;align-items:flex-start;margin-bottom:18px}
    .view-head{display:flex;justify-content:space-between;gap:18px;align-items:flex-start;margin-bottom:18px}
    h1{font-size:42px;line-height:.98;letter-spacing:-.055em;margin:0 0 8px}
    h2{font-size:20px;letter-spacing:-.035em;margin:0}
    h3{font-size:16px;letter-spacing:-.02em;margin:0}
    .muted{color:var(--muted);font-size:13px;line-height:1.55}
    .actions{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}
    .button,button{border:1px solid var(--line-2);border-radius:999px;background:var(--panel-2);padding:9px 14px;font-weight:800;cursor:pointer;color:var(--ink);box-shadow:0 5px 18px #0000000a}
    .button.primary,button.primary{background:var(--ink);border-color:var(--ink);color:#fffaf0}
    .button.subtle,button.subtle{background:#efe7d5}
    .button.danger,button.danger{background:#fff1ed;color:var(--bad);border-color:#efc7bd}
    .cards{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:18px 0}
    .metric{background:rgba(255,250,240,.88);border:1px solid var(--line);border-radius:24px;padding:16px;box-shadow:0 18px 50px #00000010}
    .metric span{display:block;color:var(--muted);font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.08em}
    .metric strong{display:block;font-size:31px;letter-spacing:-.055em;margin-top:8px}
    .grid{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(360px,.65fr);gap:14px;align-items:start}
    .stack{display:grid;gap:14px}
    .card{background:rgba(255,250,240,.92);border:1px solid var(--line);border-radius:26px;box-shadow:0 18px 50px #00000012;padding:18px}
    .card-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:14px}
    .account-list{display:grid;gap:10px}
    .account{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;align-items:center;padding:14px;border:1px solid var(--line);border-radius:20px;background:var(--panel-2)}
    .account-title{display:flex;gap:9px;align-items:center;min-width:0}
    .dot{width:10px;height:10px;border-radius:999px;background:var(--good);box-shadow:0 0 0 4px #dff0e8}
    .dot.bad{background:var(--bad);box-shadow:0 0 0 4px #f4dddd}.dot.idle{background:var(--warn);box-shadow:0 0 0 4px #f8ead0}
    .account-title b{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .account-meta{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
    .account-actions{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}
    .pill{border-radius:999px;padding:5px 9px;background:#efe7d5;font-size:12px;font-weight:800;color:#4d594f}
    .pill.ok{background:#dff0e8;color:var(--good)}.pill.bad{background:#f4dddd;color:var(--bad)}.pill.blue{background:#dfe8fb;color:var(--brand)}.pill.warn{background:#f8ead0;color:var(--warn)}
    details{border:1px solid var(--line);border-radius:22px;background:var(--panel-2);overflow:hidden}
    summary{list-style:none;cursor:pointer;padding:15px 16px;font-weight:900;display:flex;justify-content:space-between;align-items:center}
    summary::-webkit-details-marker{display:none}
    summary:after{content:"展开";font-size:12px;color:var(--muted);font-weight:800}
    details[open] summary:after{content:"收起"}
    form{padding:0 16px 16px}
    .form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:11px 12px}
    label{display:block;font-size:12px;font-weight:900;color:var(--muted);margin:0 0 6px}
    input,select{width:100%;border:1px solid var(--line-2);border-radius:14px;padding:10px 11px;background:#fffef9;color:var(--ink);outline:none}
    input:focus,select:focus{border-color:#8da2d4;box-shadow:0 0 0 4px #dfe8fb}
    .check-row{display:flex;align-items:center;gap:8px;padding-top:22px;color:var(--muted);font-size:13px;font-weight:800}
    .check-row input{width:auto}
    .test-box{display:grid;gap:12px}
    .test-controls{display:grid;grid-template-columns:1fr 1fr;gap:10px}
    .result{border-radius:18px;background:#1d211d;color:#e9f1df;padding:14px;overflow:auto;max-height:300px;font-size:12px;line-height:1.55;white-space:pre-wrap}
    .events{display:grid;gap:8px}
    .event{display:grid;grid-template-columns:96px minmax(0,1fr);gap:10px;padding:10px;border-radius:16px;background:var(--panel-2);border:1px solid var(--line)}
    .event code{font-size:12px;color:var(--muted)}
    .rotation-list{display:grid;gap:10px}
    .rotation-step{display:flex;gap:10px;align-items:flex-start;padding:11px;border:1px solid var(--line);border-radius:17px;background:var(--panel-2)}
    .rotation-step b{display:grid;place-items:center;flex:0 0 24px;width:24px;height:24px;border-radius:999px;background:#efe7d5;font-size:12px}
    .config-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
    .config-line{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:center;padding:10px 11px;border:1px solid var(--line);border-radius:16px;background:var(--panel-2)}
    .config-label{color:var(--muted);font-size:11px;font-weight:900;margin-bottom:4px}
    .config-line code{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#2d382f;font-size:12px}
    .copy-btn{padding:6px 10px;font-size:12px}
    .empty{padding:22px;border:1px dashed var(--line-2);border-radius:20px;background:#fffdf7;color:var(--muted);text-align:center}
    .toast{position:fixed;right:22px;bottom:22px;max-width:420px;padding:13px 15px;border-radius:18px;background:#17211b;color:#fffaf0;box-shadow:0 18px 48px #00000030;opacity:0;transform:translateY(8px);pointer-events:none;transition:.18s ease}
    .toast.show{opacity:1;transform:translateY(0)}
    @media(max-width:960px){.shell{grid-template-columns:1fr}aside{position:relative;height:auto}.side-note{position:static;margin-top:18px}main{width:100%;padding:24px 16px}.hero{display:grid}.actions{justify-content:flex-start}.cards{grid-template-columns:repeat(2,minmax(0,1fr))}.grid{grid-template-columns:1fr}.form-grid,.test-controls,.config-grid{grid-template-columns:1fr}}
  </style>
</head>
<body>
  <div class="shell">
    <aside>
      <div class="brand"><div class="logo"></div><div><b>Brevyn Doc Gateway</b><span>MinerU SDK Pool</span></div></div>
      <nav>
        <a class="active" href="#dashboard" data-view-link="dashboard">总览</a>
        <a href="#accounts" data-view-link="accounts">账号池</a>
        <a href="#test" data-view-link="test">测试诊断</a>
        <a href="#events" data-view-link="events">运行记录</a>
      </nav>
      <div class="side-note">这是给 Electron / sub2 走的文档解析网关。页面只管理账号、调度和测试，不暴露 MinerU 底层 URL。</div>
    </aside>
    <main>
      <section id="dashboard-view" class="view active" data-view="dashboard">
        <div class="hero">
          <div>
            <h1>Document Parse<br/>Control Room</h1>
            <div class="muted">Python FastAPI + mineru-open-sdk。快速模式无 token，精细模式走账号池 token 和并发调度。</div>
            <div class="muted" id="last-refresh">等待实时状态...</div>
          </div>
          <div class="actions">
            <button id="refresh-btn" class="subtle" type="button">刷新状态</button>
            <button id="probe-btn" class="primary" type="button">探测账号</button>
          </div>
        </div>
        <section class="cards" aria-label="服务指标">
          <div class="metric"><span>账号总数</span><strong id="metric-accounts">0</strong><div class="muted" id="metric-account-note">等待加载</div></div>
          <div class="metric"><span>解析请求</span><strong id="metric-requests">0</strong><div class="muted" id="metric-success-note">成功 0 · 失败 0</div></div>
          <div class="metric"><span>缓存命中</span><strong id="metric-cache">0</strong><div class="muted" id="metric-cache-note">缓存状态未知</div></div>
          <div class="metric"><span>平均耗时</span><strong id="metric-duration">0ms</strong><div class="muted" id="metric-uptime">运行 0s</div></div>
        </section>
        <section class="card" style="margin-bottom:14px">
          <div class="card-head"><div><h2>sub2 填写提示</h2><div class="muted">这个网关对外按 OpenAI Responses 风格暴露。Base URL 会按当前 admin 访问地址自动检测，服务器部署后打开服务器地址即可。</div></div></div>
          <div class="config-grid">
            <div class="config-line"><div><div class="config-label">接口类型</div><code id="hint-provider">OpenAI Responses / OpenAI-compatible Responses</code></div><button class="copy-btn" data-copy="hint-provider" type="button">复制</button></div>
            <div class="config-line"><div><div class="config-label">模型名</div><code id="hint-model">brevyn-doc-parse</code></div><button class="copy-btn" data-copy="hint-model" type="button">复制</button></div>
            <div class="config-line"><div><div class="config-label">Base URL（自动检测，外部访问推荐）</div><code id="hint-local-base">自动检测中...</code></div><button class="copy-btn" data-copy="hint-local-base" type="button">复制</button></div>
            <div class="config-line"><div><div class="config-label">Base URL（推荐：分开 Docker 网络，sub2 容器访问宿主机端口）</div><code id="hint-docker-base">http://host.docker.internal:8090/v1</code></div><button class="copy-btn" data-copy="hint-docker-base" type="button">复制</button></div>
            <div class="config-line"><div><div class="config-label">Linux 服务器 sub2 compose 需要</div><code id="hint-linux-extra-host">extra_hosts: ["host.docker.internal:host-gateway"]</code></div><button class="copy-btn" data-copy="hint-linux-extra-host" type="button">复制</button></div>
            <div class="config-line"><div><div class="config-label">接口路径</div><code id="hint-endpoint">POST /v1/responses</code></div><button class="copy-btn" data-copy="hint-endpoint" type="button">复制</button></div>
            <div class="config-line"><div><div class="config-label">API Key</div><code id="hint-key">当前未启用；sub2 必填时可填 not-required</code></div><button class="copy-btn" data-copy="hint-key" data-copy-literal="not-required" type="button">复制</button></div>
          </div>
          <div class="muted" style="margin-top:10px">当前 Docker 映射是宿主机 8090 -> 容器 8090。为了让 sub2 和网关保持两个独立网络，sub2 容器里不要填 localhost，填 host.docker.internal 访问宿主机发布端口。</div>
        </section>
        <div class="grid">
          <section class="card">
            <div class="card-head"><div><h2>账号池轮换机制</h2><div class="muted">这里展示真实调度规则和当前账号排序状态。</div></div></div>
            <div id="rotation-summary" class="rotation-list"></div>
          </section>
          <section class="card">
            <div class="card-head"><div><h2>最近运行</h2><div class="muted">实时刷新最近事件。</div></div></div>
            <div id="events-mini" class="events"></div>
          </section>
        </div>
      </section>

      <section id="accounts-view" class="view" data-view="accounts">
        <div class="view-head">
          <div><h1>账号池</h1><div class="muted">管理 MinerU 账号、并发、RPM 和失败冷却。</div></div>
          <button id="new-account-btn" class="primary" type="button">新增账号</button>
        </div>
        <div class="stack">
          <section class="card">
            <div class="card-head">
              <div><h2>账号池</h2><div class="muted">按模式、优先级、并发和冷却状态选择可用账号。</div></div>
            </div>
            <div id="accounts" class="account-list"></div>
          </section>

          <details id="account-editor" class="card">
            <summary><span id="editor-title">添加 / 更新账号</span></summary>
            <form id="account-form">
              <div class="form-grid">
                <div><label>账号 ID</label><input name="id" required placeholder="mineru-a" /></div>
                <div><label>显示名称</label><input name="name" placeholder="MinerU Account A" /></div>
                <div><label>模式</label><select name="mode"><option value="flash">快速 flash（无需 token）</option><option value="precision">精细 precision（需要 token）</option></select></div>
                <div><label>精细模型</label><input name="model" value="vlm" placeholder="vlm" /></div>
                <div><label>Token</label><input name="apiKey" type="password" placeholder="precision 必填；更新时留空保留原 token" /></div>
                <div><label>优先级</label><input name="priority" type="number" value="10" /></div>
                <div><label>最大并发</label><input name="maxConcurrency" type="number" value="1" min="1" /></div>
                <div><label>每分钟提交</label><input name="submitPerMinute" type="number" value="45" min="1" /></div>
                <div><label>失败冷却秒</label><input name="cooldownSeconds" type="number" value="60" min="1" /></div>
                <label class="check-row"><input name="enabled" type="checkbox" checked /> 启用这个账号</label>
              </div>
              <div class="actions" style="justify-content:flex-start;margin-top:14px">
                <button class="primary" type="submit">保存账号</button>
                <button id="reset-form-btn" type="button">清空表单</button>
              </div>
            </form>
          </details>
        </div>
      </section>

      <section id="test-view" class="view" data-view="test">
        <div class="view-head">
          <div><h1>测试诊断</h1><div class="muted">先做不耗额度的配置探测；需要真实验证时再选择文件解析。</div></div>
          <button id="probe-btn-secondary" class="primary" type="button">探测账号</button>
        </div>
        <section class="card">
          <div class="test-box">
            <div class="test-controls">
              <div><label>测试模式</label><select id="test-mode"><option value="flash">快速 flash</option><option value="precision">精细 precision</option></select></div>
              <div><label>测试文件</label><input id="test-file" type="file" accept=".pdf,.png,.jpg,.jpeg,.gif,.docx,.pptx" /></div>
            </div>
            <div class="actions" style="justify-content:flex-start">
              <button id="run-test-btn" class="primary" type="button">真实解析测试</button>
              <button id="clear-test-btn" type="button">清空结果</button>
            </div>
            <div id="probe-results" class="muted">还没有探测结果。</div>
            <div id="test-result" class="result">等待测试...</div>
          </div>
        </section>
      </section>

      <section id="events-view" class="view" data-view="events">
        <div class="view-head"><div><h1>运行记录</h1><div class="muted">最近 24 条解析、缓存和失败事件，实时轮询刷新。</div></div></div>
        <section class="card">
          <div id="events" class="events"></div>
        </section>
      </section>
    </main>
  </div>
  <div id="toast" class="toast"></div>
<script>
const state = { status:null, config:null, probe:null, view:'dashboard', refreshing:false };
const $ = (id) => document.getElementById(id);
function escapeHtml(value){return String(value ?? '').replace(/[&<>"]/g,(char)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[char]))}
function fmtMs(ms){if(!ms)return '0ms'; if(ms<1000)return `${ms}ms`; return `${(ms/1000).toFixed(1)}s`}
function fmtAge(iso){if(!iso)return ''; const diff = Math.max(0, Date.now() - new Date(iso).getTime()); if(diff < 60000)return `${Math.round(diff/1000)} 秒前`; if(diff < 3600000)return `${Math.round(diff/60000)} 分钟前`; return `${Math.round(diff/3600000)} 小时前`}
function fmtLocalTime(ms){return ms ? new Date(ms).toLocaleTimeString('zh-CN', {hour:'2-digit', minute:'2-digit', second:'2-digit'}) : '尚未使用'}
function toast(message){const node=$('toast'); node.textContent=message; node.classList.add('show'); window.clearTimeout(toast.timer); toast.timer=window.setTimeout(()=>node.classList.remove('show'),2600)}
async function json(path,opt){
  const res = await fetch(path,opt);
  const data = await res.json().catch(()=>({}));
  if(!res.ok) throw new Error(data.detail || JSON.stringify(data));
  return data;
}
function mergedAccounts(){
  const runtime = new Map((state.status?.accounts || []).map((item)=>[item.id,item]));
  return (state.config?.accounts || []).map((item)=>({...item,...(runtime.get(item.id)||{})}));
}
function renderOverview(){
  const accounts = mergedAccounts();
  const metrics = state.status?.metrics || {};
  const enabled = accounts.filter((item)=>item.enabled).length;
  const active = accounts.reduce((sum,item)=>sum + (item.active || 0), 0);
  $('metric-accounts').textContent = String(accounts.length);
  $('metric-account-note').textContent = `${enabled} 个启用 · ${active} 个运行中`;
  $('metric-requests').textContent = String(metrics.total_parse_requests || 0);
  $('metric-success-note').textContent = `成功 ${metrics.successes || 0} · 失败 ${metrics.failures || 0}`;
  $('metric-cache').textContent = String(metrics.cache_hits || 0);
  $('metric-cache-note').textContent = state.status?.cache?.enabled ? `已启用 · ${state.status.cache.dir}` : '未启用';
  $('metric-duration').textContent = fmtMs(metrics.avg_duration_ms || 0);
  $('metric-uptime').textContent = `运行 ${fmtMs(state.status?.uptime_ms || 0)}`;
  $('last-refresh').textContent = `实时状态：${new Date().toLocaleTimeString('zh-CN')} 更新 · 每 3 秒自动刷新`;
  $('hint-model').textContent = state.status?.model || 'brevyn-doc-parse';
  $('hint-local-base').textContent = `${location.origin}/v1`;
}
function accountAvailability(account){
  if(!account.enabled)return {ok:false, label:'已停用', cls:'bad'};
  if(account.mode === 'precision' && !account.apiKeySet)return {ok:false, label:'缺 token', cls:'bad'};
  if((account.cooldownMsRemaining || 0) > 0)return {ok:false, label:`冷却 ${fmtMs(account.cooldownMsRemaining)}`, cls:'warn'};
  if((account.active || 0) >= (account.maxConcurrency || 1))return {ok:false, label:'并发已满', cls:'warn'};
  if((account.minuteSubmits || 0) >= (account.submitPerMinute || 1))return {ok:false, label:'RPM 已满', cls:'warn'};
  return {ok:true, label:'可调度', cls:'ok'};
}
function sortedForRouting(mode){
  return mergedAccounts()
    .filter((account)=>account.mode === mode)
    .map((account)=>({...account, availability: accountAvailability(account)}))
    .sort((a,b)=>(a.priority ?? 100)-(b.priority ?? 100)
      || ((a.active || 0)/(a.maxConcurrency || 1))-((b.active || 0)/(b.maxConcurrency || 1))
      || (a.lastUsedAtMs || 0)-(b.lastUsedAtMs || 0));
}
function renderRotation(){
  const routing = state.status?.routing;
  const flash = sortedForRouting('flash');
  const precision = sortedForRouting('precision');
  const order = (routing?.order || []).map((step, index)=>`<div class="rotation-step"><b>${index+1}</b><div>${escapeHtml(step)}</div></div>`).join('');
  const lane = (title, accounts)=>`<div><h3>${title}</h3><div class="account-meta" style="margin:8px 0 12px">${accounts.length ? accounts.map((account, index)=>`<span class="pill ${account.availability.cls}">${index+1}. ${escapeHtml(account.name || account.id)} · ${account.availability.label}</span>`).join('') : '<span class="pill warn">没有账号</span>'}</div></div>`;
  $('rotation-summary').innerHTML = `
    <div class="muted">${escapeHtml(routing?.summary || '等待调度信息')}</div>
    ${lane('快速 flash 队列', flash)}
    ${lane('精细 precision 队列', precision)}
    <div class="rotation-list">${order}</div>`;
}
function renderAccounts(){
  const accounts = mergedAccounts();
  if(!accounts.length){
    $('accounts').innerHTML = '<div class="empty">还没有账号。可以先新增一个 flash 账号做轻量解析，或者新增 precision 账号填 token。</div>';
    return;
  }
  $('accounts').innerHTML = accounts.map((account)=>{
    const cooling = (account.cooldownMsRemaining || 0) > 0;
    const availability = accountAvailability(account);
    const dotClass = availability.ok ? '' : (availability.cls === 'bad' ? 'bad' : 'idle');
    const tokenText = account.mode === 'precision' ? (account.apiKeySet ? 'token 已配置' : '缺 token') : '无需 token';
    const tokenClass = account.mode === 'precision' && !account.apiKeySet ? 'bad' : 'ok';
    return `<article class="account">
      <div>
        <div class="account-title"><span class="dot ${dotClass}"></span><b>${escapeHtml(account.name || account.id)}</b><span class="muted">${escapeHtml(account.id)}</span></div>
        <div class="account-meta">
          <span class="pill ${account.mode === 'precision' ? 'blue' : 'ok'}">${account.mode === 'precision' ? '精细' : '快速'}</span>
          <span class="pill ${account.enabled ? 'ok' : 'bad'}">${account.enabled ? '启用' : '停用'}</span>
          <span class="pill ${tokenClass}">${tokenText}</span>
          <span class="pill">并发 ${account.active || 0}/${account.maxConcurrency || 1}</span>
          <span class="pill">RPM ${account.minuteSubmits || 0}/${account.submitPerMinute || 0}</span>
          <span class="pill">优先级 ${account.priority ?? 100}</span>
          <span class="pill ${availability.cls}">${availability.label}</span>
          ${cooling ? `<span class="pill warn">冷却 ${fmtMs(account.cooldownMsRemaining)}</span>` : ''}
          <span class="pill">最近使用 ${fmtLocalTime(account.lastUsedAtMs)}</span>
          <span class="pill">成功 ${account.successes || 0} · 失败 ${account.failures || 0}</span>
        </div>
      </div>
      <div class="account-actions">
        <button type="button" data-edit="${escapeHtml(account.id)}">编辑</button>
        <button class="danger" type="button" data-delete="${escapeHtml(account.id)}">删除</button>
      </div>
    </article>`;
  }).join('');
  document.querySelectorAll('[data-edit]').forEach((button)=>button.addEventListener('click',()=>editAccount(button.dataset.edit)));
  document.querySelectorAll('[data-delete]').forEach((button)=>button.addEventListener('click',()=>deleteAccount(button.dataset.delete)));
}
function renderEvents(targetId='events', limit=24){
  const events = state.status?.metrics?.recent_events || [];
  if(!events.length){
    $(targetId).innerHTML = '<div class="empty">暂无运行记录。解析请求、失败、缓存命中会显示在这里。</div>';
    return;
  }
  $(targetId).innerHTML = events.slice(0, limit).map((event)=>{
    const title = event.type === 'parse_success' ? '解析成功' : event.type === 'parse_failed' ? '解析失败' : event.type === 'cache_hit' ? '缓存命中' : event.type;
    const meta = [event.file, event.mode, event.account_id, event.duration_ms ? fmtMs(event.duration_ms) : '', event.message].filter(Boolean).join(' · ');
    return `<div class="event"><code>${escapeHtml(fmtAge(event.at))}</code><div><b>${escapeHtml(title)}</b><div class="muted">${escapeHtml(meta || '-')}</div></div></div>`;
  }).join('');
}
function renderProbe(){
  if(!state.probe){return}
  const results = state.probe.results || [];
  if(!results.length){
    $('probe-results').innerHTML = '<span class="pill warn">没有可探测账号</span>';
    return;
  }
  $('probe-results').innerHTML = results.map((item)=>`<span class="pill ${item.ok ? 'ok' : 'bad'}">${escapeHtml(item.name || item.id)} · ${item.ok ? '配置可用' : '不可用'}</span>`).join(' ');
}
async function refresh(){
  if(state.refreshing)return;
  state.refreshing = true;
  try{
    const [status, config] = await Promise.all([json('/api/admin/status'), json('/api/admin/config')]);
    state.status = status; state.config = config;
    renderOverview(); renderRotation(); renderAccounts(); renderEvents('events', 24); renderEvents('events-mini', 6); renderProbe();
  } finally {
    state.refreshing = false;
  }
}
async function runProbe(){
  state.probe = await json('/api/admin/probe', {method:'POST'});
  renderProbe();
  $('test-result').textContent = JSON.stringify(state.probe, null, 2);
  toast('账号探测完成');
}
function resetForm(){
  const form = $('account-form');
  form.reset();
  form.elements.enabled.checked = true;
  form.elements.model.value = 'vlm';
  form.elements.priority.value = 10;
  form.elements.maxConcurrency.value = 1;
  form.elements.submitPerMinute.value = 45;
  form.elements.cooldownSeconds.value = 60;
  $('editor-title').textContent = '添加 / 更新账号';
}
function editAccount(id){
  const account = (state.config?.accounts || []).find((item)=>item.id === id);
  if(!account)return;
  const form = $('account-form');
  form.elements.id.value = account.id;
  form.elements.name.value = account.name || '';
  form.elements.mode.value = account.mode || 'flash';
  form.elements.apiKey.value = '';
  form.elements.model.value = account.model || 'vlm';
  form.elements.priority.value = account.priority ?? 10;
  form.elements.maxConcurrency.value = account.maxConcurrency ?? 1;
  form.elements.submitPerMinute.value = account.submitPerMinute ?? 45;
  form.elements.cooldownSeconds.value = account.cooldownSeconds ?? 60;
  form.elements.enabled.checked = account.enabled !== false;
  $('editor-title').textContent = `编辑账号：${account.id}`;
  $('account-editor').open = true;
  $('account-editor').scrollIntoView({block:'center'});
}
async function deleteAccount(id){
  if(!confirm(`删除账号 ${id}？`))return;
  await json(`/api/admin/accounts/${encodeURIComponent(id)}`, {method:'DELETE'});
  toast('账号已删除');
  await refresh();
}
async function saveAccount(event){
  event.preventDefault();
  const f = event.currentTarget.elements;
  await json('/api/admin/accounts', {
    method:'POST',
    headers:{'content-type':'application/json'},
    body:JSON.stringify({
      id:f.id.value,
      name:f.name.value,
      mode:f.mode.value,
      apiKey:f.apiKey.value,
      model:f.model.value,
      priority:+f.priority.value,
      maxConcurrency:+f.maxConcurrency.value,
      submitPerMinute:+f.submitPerMinute.value,
      cooldownSeconds:+f.cooldownSeconds.value,
      enabled:f.enabled.checked
    })
  });
  toast('账号已保存');
  resetForm();
  $('account-editor').open = false;
  await refresh();
}
function readAsDataUrl(file){
  return new Promise((resolve,reject)=>{
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
async function runParseTest(){
  const file = $('test-file').files[0];
  if(!file){toast('先选择一个测试文件');return}
  const mode = $('test-mode').value;
  if(!confirm(`将使用 ${mode} 模式真实提交 ${file.name}，可能消耗 MinerU 额度。继续？`))return;
  $('test-result').textContent = '上传并解析中...';
  const dataUrl = await readAsDataUrl(file);
  const started = Date.now();
  const result = await json('/api/admin/parse-test', {
    method:'POST',
    headers:{'content-type':'application/json'},
    body:JSON.stringify({
      model: state.status?.model || 'brevyn-doc-parse',
      parse_options:{mode},
      input:[{role:'user', content:[{type:'input_file', filename:file.name, file_data:dataUrl}]}]
    })
  });
  const text = result.output_text || '';
  $('test-result').textContent = `完成：${fmtMs(Date.now()-started)}\\nmetadata: ${JSON.stringify(result.metadata || {}, null, 2)}\\n\\n${text.slice(0, 4000)}`;
  toast('测试解析完成');
  await refresh();
}
function setView(view){
  state.view = view;
  document.querySelectorAll('[data-view]').forEach((panel)=>panel.classList.toggle('active', panel.dataset.view === view));
  document.querySelectorAll('[data-view-link]').forEach((link)=>link.classList.toggle('active', link.dataset.viewLink === view));
  window.location.hash = view;
}
document.querySelectorAll('[data-view-link]').forEach((link)=>link.addEventListener('click',(event)=>{
  event.preventDefault();
  setView(link.dataset.viewLink);
}));
document.querySelectorAll('[data-copy]').forEach((button)=>button.addEventListener('click',async()=>{
  const value = button.dataset.copyLiteral || $(button.dataset.copy)?.textContent || '';
  await navigator.clipboard.writeText(value);
  toast('已复制');
}));
$('refresh-btn').addEventListener('click',()=>refresh().then(()=>toast('状态已刷新')).catch((err)=>toast(err.message)));
$('probe-btn').addEventListener('click',()=>runProbe().catch((err)=>toast(err.message)));
$('probe-btn-secondary').addEventListener('click',()=>runProbe().catch((err)=>toast(err.message)));
$('new-account-btn').addEventListener('click',()=>{setView('accounts'); resetForm(); $('account-editor').open = true; $('account-editor').scrollIntoView({block:'center'});});
$('reset-form-btn').addEventListener('click',resetForm);
$('account-form').addEventListener('submit',(event)=>saveAccount(event).catch((err)=>toast(err.message)));
$('run-test-btn').addEventListener('click',()=>runParseTest().catch((err)=>{$('test-result').textContent = err.message; toast(err.message)}));
$('clear-test-btn').addEventListener('click',()=>{$('test-result').textContent='等待测试...'; $('probe-results').textContent='还没有探测结果。'; state.probe=null;});
setView((window.location.hash || '#dashboard').slice(1));
refresh().catch((err)=>toast(err.message));
window.setInterval(()=>refresh().catch(()=>{}), 3000);
</script></body></html>"""
