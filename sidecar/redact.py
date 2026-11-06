"""Redact secrets from logs and serialized payloads."""
from __future__ import annotations

import logging
import re
from typing import Any

# sk-… / Bearer / common key shapes. Never log these.
_SECRET_RE = re.compile(
    r"(?i)(api[_-]?key|authorization|bearer|secret|token)\s*[=:]\s*['\"]?([^\s'\",]+)"
)
_SK_RE = re.compile(r"\bsk-[A-Za-z0-9_\-]{8,}\b")


def redact_text(text: str) -> str:
    if not text:
        return text
    out = _SK_RE.sub("sk-***", text)
    out = _SECRET_RE.sub(lambda m: f"{m.group(1)}=***", out)
    return out


def redact_obj(obj: Any) -> Any:
    if isinstance(obj, str):
        return redact_text(obj)
    if isinstance(obj, dict):
        redacted = {}
        for k, v in obj.items():
            if str(k).lower() in {
                "api_key",
                "apikey",
                "authorization",
                "token",
                "secret",
                "password",
            }:
                redacted[k] = "***"
            else:
                redacted[k] = redact_obj(v)
        return redacted
    if isinstance(obj, list):
        return [redact_obj(x) for x in obj]
    return obj


class RedactFilter(logging.Filter):
    """Logging filter that scrubs secrets from record messages/args."""

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            if isinstance(record.msg, str):
                record.msg = redact_text(record.msg)
            if record.args:
                if isinstance(record.args, dict):
                    record.args = {k: redact_obj(v) for k, v in record.args.items()}
                elif isinstance(record.args, tuple):
                    record.args = tuple(redact_obj(a) for a in record.args)
        except Exception:
            pass
        return True
