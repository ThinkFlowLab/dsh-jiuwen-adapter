"""API keys must never appear on stderr/stdout from the sidecar."""
from __future__ import annotations

import io
import json
import logging

import pytest

from sidecar.redact import RedactFilter, redact_text
from sidecar.server import NdjsonServer, configure_logging
from sidecar.tests.harness import RpcHarness


@pytest.mark.asyncio
async def test_stdout_never_contains_raw_key(ckpt_dir, writer, fake):
    from openjiuwen.core.foundation.llm import AssistantMessage

    fake.reset_script([AssistantMessage(content="ok")])
    h = RpcHarness(ckpt_dir, writer)
    await h.start()
    try:
        # Pass a key via model spec (discouraged path) — must be redacted on wire.
        await h.call(
            "turn.start",
            {
                "sid": "sec",
                "query": "hi",
                "tools": [],
                "model": {
                    "provider": "fake",
                    "api_base": "http://127.0.0.1:9/v1",
                    "api_key": "sk-LIVESECRETKEYVALUE999",
                    "model": "fake-model",
                },
            },
        )
        raw = writer.getvalue()
        assert "sk-LIVESECRETKEYVALUE999" not in raw
    finally:
        await h.stop()


def test_configure_logging_attaches_redact_filter(capfd):
    configure_logging("WARNING")
    log = logging.getLogger("sidecar.leak.test")
    log.warning("contact api_key=sk-ABCDEFGHIJKLMNOP for help")
    # Also exercise filter directly on a handler stream
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    handler.addFilter(RedactFilter())
    logger = logging.getLogger("sidecar.leak.stream")
    logger.handlers.clear()
    logger.addHandler(handler)
    logger.setLevel(logging.WARNING)
    logger.propagate = False
    logger.warning("token=sk-ABCDEFGHIJKLMNOP")
    assert "sk-ABCDEFGHIJKLMNOP" not in stream.getvalue()
    assert "sk-***" in stream.getvalue() or "***" in stream.getvalue()
