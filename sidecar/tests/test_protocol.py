"""RPC method coverage: happy path + error paths."""
from __future__ import annotations

import asyncio
import json
import logging

import pytest

from sidecar.redact import RedactFilter, redact_obj, redact_text
from sidecar.server import NdjsonServer, configure_logging
from sidecar.tests.harness import RpcHarness


@pytest.mark.asyncio
async def test_ping_and_shutdown(ckpt_dir, writer, fake):
    h = RpcHarness(ckpt_dir, writer)
    await h.start()
    try:
        r = await h.call("ping", {})
        assert r["result"]["pong"] is True
        r2 = await h.call("shutdown", {})
        assert r2["result"]["ok"] is True
        assert h._server._stopping.is_set()
    finally:
        await h.stop()


@pytest.mark.asyncio
async def test_unknown_method(ckpt_dir, writer, fake):
    h = RpcHarness(ckpt_dir, writer)
    await h.start()
    try:
        r = await h.call("no.such", {})
        assert "error" in r
        assert r["error"]["code"] == -32601
    finally:
        await h.stop()


@pytest.mark.asyncio
async def test_malformed_json_line(ckpt_dir, writer, fake, caplog):
    configure_logging("WARNING")
    server = NdjsonServer(writer_file=writer, checkpoint_dir=ckpt_dir)
    await server.manager.start()
    try:
        with caplog.at_level(logging.WARNING):
            await server.feed_line("not-json{{{")
        assert any("invalid json" in r.message for r in caplog.records)
        # Non-object JSON is ignored
        await server.feed_line("[]")
        await server.feed_line("")
    finally:
        await server.manager.stop()


@pytest.mark.asyncio
async def test_missing_params(ckpt_dir, writer, fake):
    h = RpcHarness(ckpt_dir, writer)
    await h.start()
    try:
        r = await h.call("turn.start", {"query": "x"})  # missing sid
        assert r["error"]["code"] == -32602
        assert "sid" in r["error"]["message"]
        r2 = await h.call("turn.start", {"sid": "s"})  # missing query
        assert r2["error"]["code"] == -32602
        r3 = await h.call("turn.cancel", {})
        assert r3["error"]["code"] == -32602
        r4 = await h.call("session.fork", {"from": "a"})
        assert r4["error"]["code"] == -32602
        r5 = await h.call("session.delete", {})
        assert r5["error"]["code"] == -32602
        r6 = await h.call("session.history", {})
        assert r6["error"]["code"] == -32602
        r7 = await h.call("tool.result", {})
        assert r7["error"]["code"] == -32602
        r8 = await h.call("turn.start", "not-a-dict")  # type: ignore[arg-type]
        # harness always sends dict; exercise server directly
        await h._server.handle_request({"id": "bad", "method": "ping", "params": []})
        lines = [l for l in writer.lines() if l.get("id") == "bad"]
        assert lines and lines[0]["error"]["code"] == -32602
    finally:
        await h.stop()


@pytest.mark.asyncio
async def test_tool_result_unknown_call_id(ckpt_dir, writer, fake):
    h = RpcHarness(ckpt_dir, writer)
    await h.start()
    try:
        r = await h.call("tool.result", {"callId": "nope", "ok": True, "content": "x"})
        assert r["result"]["ok"] is True  # soft-ack; logged warning
    finally:
        await h.stop()


@pytest.mark.asyncio
async def test_history_unknown_sid(ckpt_dir, writer, fake):
    h = RpcHarness(ckpt_dir, writer)
    await h.start()
    try:
        r = await h.call("session.history", {"sid": "missing"})
        assert r["result"]["ok"] is True
        assert r["result"]["messages"] == []
    finally:
        await h.stop()


@pytest.mark.asyncio
async def test_cancel_unknown_sid(ckpt_dir, writer, fake):
    h = RpcHarness(ckpt_dir, writer)
    await h.start()
    try:
        r = await h.call("turn.cancel", {"sid": "ghost"})
        assert r["result"]["ok"] is True
        assert r["result"]["cancelled"] is False
    finally:
        await h.stop()


def test_redact_text_and_obj():
    assert "sk-***" in redact_text("key=sk-abcdefghijklmnop")
    assert "sk-***" == redact_text("sk-abcdefghijklmnop")
    assert redact_obj({"api_key": "sk-secretvalue123", "x": 1})["api_key"] == "***"
    assert "sk-***" in redact_text("Authorization: Bearer sk-abcdefghijklmnop")


def test_redact_filter_on_logger(caplog):
    configure_logging("WARNING")
    log = logging.getLogger("sidecar.redact.test")
    log.addFilter(RedactFilter())
    with caplog.at_level(logging.WARNING):
        log.warning("using api_key=sk-SUPERSECRETKKEY99 for call")
    joined = " ".join(r.message for r in caplog.records)
    assert "sk-SUPERSECRETKKEY99" not in joined
    assert "sk-***" in joined or "***" in joined
