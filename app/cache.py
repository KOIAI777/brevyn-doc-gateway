from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any


def cache_key(*, file_bytes: bytes, filename: str, model: str, mode: str, options: dict) -> str:
    digest = hashlib.sha256(file_bytes).hexdigest()
    raw = json.dumps({
        "file": digest,
        "filename": filename,
        "model": model,
        "mode": mode,
        "options": options,
    }, sort_keys=True)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


class DiskCache:
    def __init__(self, enabled: bool, directory: str):
        self.enabled = enabled
        self.directory = Path(directory)

    def get(self, key: str) -> dict[str, Any] | None:
        if not self.enabled:
            return None
        path = self.directory / f"{key}.json"
        if not path.exists():
            return None
        return json.loads(path.read_text("utf-8"))

    def set(self, key: str, value: dict[str, Any]) -> None:
        if not self.enabled:
            return
        self.directory.mkdir(parents=True, exist_ok=True)
        (self.directory / f"{key}.json").write_text(json.dumps(value, ensure_ascii=False, indent=2), "utf-8")
