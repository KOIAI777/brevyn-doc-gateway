from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, Field


Mode = Literal["flash", "precision"]


class Account(BaseModel):
    id: str
    name: str = ""
    mode: Mode = "flash"
    token: str = ""
    enabled: bool = True
    priority: int = 100
    max_concurrency: int = Field(default=1, ge=1)
    submit_per_minute: int = Field(default=45, ge=1)
    cooldown_seconds: int = Field(default=60, ge=1)
    model: str = "vlm"


class GatewayConfig(BaseModel):
    model: str = "brevyn-doc-parse"
    default_mode: Mode = "flash"
    cache_enabled: bool = True
    cache_dir: str = "./data/cache"
    request_timeout_seconds: int = 1200
    accounts: list[Account] = Field(default_factory=list)


def config_path() -> Path:
    return Path(os.environ.get("CONFIG_PATH", "./data/config.json"))


def load_config() -> GatewayConfig:
    path = config_path()
    if not path.exists():
        return GatewayConfig()
    data = json.loads(path.read_text("utf-8"))
    if "mineru" in data or "gateway" in data:
        return _load_legacy_node_config(data)
    return GatewayConfig.model_validate(data)


def save_config(config: GatewayConfig) -> None:
    path = config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(config.model_dump_json(indent=2), "utf-8")


def public_config(config: GatewayConfig) -> dict[str, Any]:
    return {
        "model": config.model,
        "defaultMode": config.default_mode,
        "cache": {
            "enabled": config.cache_enabled,
            "dir": config.cache_dir,
        },
        "accounts": [
            {
                "id": account.id,
                "name": account.name,
                "mode": account.mode,
                "enabled": account.enabled,
                "priority": account.priority,
                "maxConcurrency": account.max_concurrency,
                "submitPerMinute": account.submit_per_minute,
                "cooldownSeconds": account.cooldown_seconds,
                "model": account.model,
                "apiKeySet": bool(account.token),
                "tokenRequired": account.mode == "precision",
            }
            for account in config.accounts
        ],
    }


def upsert_account(config: GatewayConfig, payload: dict[str, Any]) -> GatewayConfig:
    account_id = str(payload.get("id", "")).strip()
    if not account_id:
        raise ValueError("account id is required")
    existing = next((item for item in config.accounts if item.id == account_id), None)
    token = str(payload.get("token") or payload.get("apiKey") or "").strip()
    if not token and existing:
        token = existing.token
    raw = {
        "id": account_id,
        "name": payload.get("name") or (existing.name if existing else account_id),
        "mode": payload.get("mode") or (existing.mode if existing else config.default_mode),
        "token": token,
        "enabled": payload.get("enabled", existing.enabled if existing else True),
        "priority": payload.get("priority", existing.priority if existing else 100),
        "max_concurrency": payload.get("maxConcurrency", existing.max_concurrency if existing else 1),
        "submit_per_minute": payload.get("submitPerMinute", existing.submit_per_minute if existing else 45),
        "cooldown_seconds": payload.get("cooldownSeconds", existing.cooldown_seconds if existing else 60),
        "model": payload.get("model") or (existing.model if existing else "vlm"),
    }
    account = Account.model_validate(raw)
    accounts = [item for item in config.accounts if item.id != account.id]
    accounts.append(account)
    accounts.sort(key=lambda item: (item.priority, item.id))
    next_config = config.model_copy(update={"accounts": accounts})
    save_config(next_config)
    return next_config


def delete_account(config: GatewayConfig, account_id: str) -> GatewayConfig:
    next_config = config.model_copy(update={
        "accounts": [item for item in config.accounts if item.id != account_id]
    })
    save_config(next_config)
    return next_config


def _load_legacy_node_config(data: dict[str, Any]) -> GatewayConfig:
    gateway = data.get("gateway") or {}
    mineru = data.get("mineru") or {}
    accounts: list[Account] = []
    for item in mineru.get("accounts") or []:
        accounts.append(Account(
            id=item.get("id") or "mineru",
            name=item.get("name") or item.get("id") or "MinerU",
            mode="precision" if item.get("mode") == "precision" else "flash",
            token=item.get("apiKey") or item.get("token") or "",
            enabled=item.get("enabled", True),
            priority=item.get("priority", 100),
            max_concurrency=item.get("maxConcurrency") or item.get("max_concurrency") or 1,
            submit_per_minute=item.get("submitPerMinute") or item.get("submit_per_minute") or 45,
            cooldown_seconds=item.get("cooldownSeconds") or item.get("cooldown_seconds") or 60,
            model=item.get("model") or "vlm",
        ))
    return GatewayConfig(
        model=gateway.get("model") or "brevyn-doc-parse",
        default_mode="precision" if gateway.get("defaultMode") == "precision" else "flash",
        cache_enabled=gateway.get("cacheEnabled", True),
        cache_dir=gateway.get("cacheDir") or "./data/cache",
        request_timeout_seconds=int(gateway.get("pollTimeoutMs", 1200000) / 1000),
        accounts=accounts,
    )
