"""Logging helpers — keep stdout free for NDJSON-RPC."""
from __future__ import annotations

import logging
import os
import sys
from typing import Optional

from .redact import RedactFilter


def _handler_uses_stdout(handler: logging.Handler) -> bool:
    stream = getattr(handler, "stream", None)
    if stream is None:
        return False
    if stream is sys.stdout:
        return True
    name = getattr(stream, "name", "") or ""
    return name in ("<stdout>", "/dev/stdout")


def configure_logging(level: Optional[str] = None) -> None:
    """Default WARNING; secret redaction; never write logs to stdout."""
    raw = level or os.environ.get("AGENTCORE_LOG_LEVEL") or "WARNING"
    try:
        lvl = getattr(logging, raw.upper())
    except AttributeError:
        lvl = logging.WARNING
    root = logging.getLogger()
    for handler in list(root.handlers):
        if _handler_uses_stdout(handler):
            root.removeHandler(handler)
            try:
                handler.close()
            except Exception:
                pass
    if not any(
        isinstance(h, logging.StreamHandler) and getattr(h, "stream", None) is sys.stderr
        for h in root.handlers
    ):
        err = logging.StreamHandler(sys.stderr)
        err.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
        root.addHandler(err)
    root.setLevel(lvl)
    redact = RedactFilter()
    for handler in logging.root.handlers:
        handler.addFilter(redact)
        if _handler_uses_stdout(handler):
            handler.stream = sys.stderr  # type: ignore[attr-defined]
    for name in (
        "openjiuwen",
        "httpx",
        "httpcore",
        "openai",
        "urllib3",
        "asyncio",
        "common",
        "session",
        "runner",
        "sys_operation",
        "harness",
    ):
        lg = logging.getLogger(name)
        lg.setLevel(max(lvl, logging.WARNING))
        for handler in list(lg.handlers):
            if _handler_uses_stdout(handler):
                lg.removeHandler(handler)
                try:
                    handler.close()
                except Exception:
                    pass
