from __future__ import annotations

import asyncio
import tempfile
from pathlib import Path

from .config import Account


class MinerUSDKClient:
    async def parse(self, *, account: Account, file_bytes: bytes, filename: str, options: dict, timeout: int) -> dict:
        return await asyncio.to_thread(
            self._parse_sync,
            account=account,
            file_bytes=file_bytes,
            filename=filename,
            options=options,
            timeout=timeout,
        )

    def _parse_sync(self, *, account: Account, file_bytes: bytes, filename: str, options: dict, timeout: int) -> dict:
        try:
            from mineru import MinerU
        except ImportError as exc:
            raise RuntimeError("mineru-open-sdk is not installed") from exc

        suffix = Path(filename).suffix or ".bin"
        with tempfile.NamedTemporaryFile(delete=True, suffix=suffix) as tmp:
            tmp.write(file_bytes)
            tmp.flush()

            client = MinerU(token=account.token or None)
            if hasattr(client, "set_source"):
                client.set_source("brevyn-doc-gateway")

            language = options.get("language") or "ch"
            ocr = optional_bool(options, "ocr", "is_ocr")
            formula = optional_bool(options, "formula", "formula_enable", "enable_formula")
            table = optional_bool(options, "table", "table_enable", "enable_table")
            pages = options.get("pages") or options.get("page_range")

            if account.mode == "flash":
                kwargs = {
                    "language": language,
                    "timeout": timeout,
                }
                if ocr is not None:
                    kwargs["is_ocr"] = ocr
                if formula is not None:
                    kwargs["enable_formula"] = formula
                if table is not None:
                    kwargs["enable_table"] = table
                if pages:
                    kwargs["page_range"] = pages
                result = client.flash_extract(tmp.name, **kwargs)
            else:
                kwargs = {
                    "model": account.model or None,
                    "language": language,
                    "timeout": timeout,
                }
                if ocr is not None:
                    kwargs["ocr"] = ocr
                if formula is not None:
                    kwargs["formula"] = formula
                if table is not None:
                    kwargs["table"] = table
                if pages:
                    kwargs["pages"] = pages
                result = client.extract(tmp.name, **kwargs)

        markdown = getattr(result, "markdown", None)
        state = getattr(result, "state", None)
        error = getattr(result, "error", None)
        if not markdown:
            raise RuntimeError(f"MinerU returned empty markdown: state={state}, error={error}")

        return {
            "markdown": markdown,
            "metadata": {
                "provider": "mineru-sdk",
                "account_id": account.id,
                "mode": account.mode,
                "filename": getattr(result, "filename", filename),
                "state": state,
            },
        }


def optional_bool(options: dict, *keys: str) -> bool | None:
    for key in keys:
        if key in options:
            return bool(options.get(key))
    return None
