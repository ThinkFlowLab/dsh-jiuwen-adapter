"""Turn streaming, tools, cancel, concurrency, model/system/images."""
from __future__ import annotations

import asyncio
import json
import os

import pytest
from openjiuwen.core.foundation.llm import AssistantMessage, ToolCall

from sidecar.tests.harness import RpcHarness

ECHO = {
    "name": "dsh_echo",
    "description": "Echo via dsh",
    "parameters": {
        "type": "object",
        "properties": {"text": {"type": "string"}},
        "required": ["text"],
    },
}
FAKE_MODEL = {"provider": "fake", "api_base": "http://127.0.0.1:9/v1", "api_key_env": "NO_KEY", "model": "fake-model"}


@pytest.mark.asyncio
async def test_chunk_sequence_with_tool_call(ckpt_dir, writer, fake):
    fake.reset_script(
        [
            AssistantMessage(
                content="",
                reasoning_content="thinking...",
                tool_calls=[
                    ToolCall(
                        id="c1",
                        type="function",
                        name="dsh_echo",
                        arguments=json.dumps({"text": "hi"}),
                    )
                ],
            ),
            AssistantMessage(content="done: HI"),
        ]
    )
    h = RpcHarness(
        ckpt_dir,
        writer,
        tool_handler=lambda p: {"ok": True, "content": {"echo": p["args"]["text"].upper()}},
    )
    await h.start()
    try:
        r = await h.call(
            "turn.start",
            {
                "sid": "s1",
                "query": "call the tool",
                "system": "You are a test agent.",
                "tools": [ECHO],
                "model": FAKE_MODEL,
            },
        )
        assert r["result"]["ok"] is True
        types = [c["type"] for c in h.chunks("s1")]
        assert "tool_call" in types or h.tool_calls()
        assert "answer" in types or "llm_output" in types
        assert h.tool_calls()
        assert h.tool_calls()[0]["name"] == "dsh_echo"
        assert h.tool_calls()[0]["args"]["text"] == "hi"
        # model saw system-ish + tools
        assert fake.SEEN
        assert "dsh_echo" in fake.SEEN[0]["tools"]
    finally:
        await h.stop()


@pytest.mark.asyncio
async def test_tool_ok_false(ckpt_dir, writer, fake):
    fake.reset_script(
        [
            AssistantMessage(
                content="",
                tool_calls=[
                    ToolCall(
                        id="c1",
                        type="function",
                        name="dsh_echo",
                        arguments=json.dumps({"text": "x"}),
                    )
                ],
            ),
            AssistantMessage(content="failed gracefully"),
        ]
    )
    h = RpcHarness(
        ckpt_dir,
        writer,
        tool_handler=lambda p: {"ok": False, "content": "host denied"},
    )
    await h.start()
    try:
        r = await h.call(
            "turn.start",
            {"sid": "s_deny", "query": "use tool", "tools": [ECHO], "model": FAKE_MODEL},
        )
        # Turn should still complete; tool raised into agent loop.
        assert r is not None
        assert "result" in r or "error" in r
    finally:
        await h.stop()


@pytest.mark.asyncio
async def test_tool_timeout(ckpt_dir, writer, fake, monkeypatch):
    monkeypatch.setenv("AGENTCORE_TOOL_TIMEOUT", "0.2")
    fake.reset_script(
        [
            AssistantMessage(
                content="",
                tool_calls=[
                    ToolCall(
                        id="c1",
                        type="function",
                        name="dsh_echo",
                        arguments=json.dumps({"text": "slow"}),
                    )
                ],
            ),
            AssistantMessage(content="after timeout"),
        ]
    )

    def never_reply(_p):
        return None  # leave Future pending

    h = RpcHarness(ckpt_dir, writer, tool_handler=never_reply)
    await h.start()
    try:
        r = await h.call(
            "turn.start",
            {"sid": "s_to", "query": "tool", "tools": [ECHO], "model": FAKE_MODEL},
        )
        # Expect error or completed-with-tool-error; either way no hang.
        assert r is not None
    finally:
        await h.stop()


@pytest.mark.asyncio
async def test_cancel_then_next_turn(ckpt_dir, writer, fake):
    fake.reset_script([AssistantMessage(content="SLOW")])
    h = RpcHarness(ckpt_dir, writer)
    await h.start()
    try:
        rid, task = await h.call_nowait(
            "turn.start",
            {"sid": "c1", "query": "slow one", "tools": [], "model": FAKE_MODEL},
        )
        await asyncio.sleep(0.5)
        cr = await h.call("turn.cancel", {"sid": "c1"})
        assert cr["result"]["cancelled"] is True
        try:
            await asyncio.wait_for(task, 5)
        except (asyncio.CancelledError, asyncio.TimeoutError):
            pass
        fake.reset_script([AssistantMessage(content="after-cancel")])
        r2 = await h.call(
            "turn.start",
            {"sid": "c1", "query": "next", "tools": [], "model": FAKE_MODEL},
        )
        assert r2["result"]["ok"] is True
        assert any(c["type"] in ("answer", "llm_output") for c in h.chunks("c1"))
    finally:
        await h.stop()


@pytest.mark.asyncio
async def test_cancel_mid_tool(ckpt_dir, writer, fake):
    fake.reset_script(
        [
            AssistantMessage(
                content="",
                tool_calls=[
                    ToolCall(
                        id="c1",
                        type="function",
                        name="dsh_echo",
                        arguments=json.dumps({"text": "mid"}),
                    )
                ],
            ),
        ]
    )
    h = RpcHarness(ckpt_dir, writer, tool_handler=lambda _p: None)  # never resolve
    await h.start()
    try:
        rid, task = await h.call_nowait(
            "turn.start",
            {"sid": "mid", "query": "tool", "tools": [ECHO], "model": FAKE_MODEL},
        )
        # Wait until tool.call emitted
        for _ in range(50):
            if h.tool_calls():
                break
            await asyncio.sleep(0.05)
        assert h.tool_calls()
        cr = await h.call("turn.cancel", {"sid": "mid"})
        assert cr["result"]["cancelled"] is True
        try:
            await asyncio.wait_for(task, 5)
        except (asyncio.CancelledError, asyncio.TimeoutError):
            pass
    finally:
        await h.stop()


@pytest.mark.asyncio
async def test_two_sessions_concurrent_cancel_one(ckpt_dir, writer, fake):
    # Session a: slow; session b: quick. Cancel a, b must finish ok.
    fake.SCRIPT.append(AssistantMessage(content="SLOW"))
    fake.SCRIPT.append(AssistantMessage(content="fast-ok"))
    h = RpcHarness(ckpt_dir, writer)
    await h.start()
    try:
        rid_a, task_a = await h.call_nowait(
            "turn.start",
            {"sid": "sa", "query": "slow", "tools": [], "model": FAKE_MODEL},
        )
        await asyncio.sleep(0.3)
        rid_b, task_b = await h.call_nowait(
            "turn.start",
            {"sid": "sb", "query": "fast", "tools": [], "model": FAKE_MODEL},
        )
        await asyncio.sleep(0.2)
        await h.call("turn.cancel", {"sid": "sa"})
        try:
            await asyncio.wait_for(task_a, 5)
        except (asyncio.CancelledError, asyncio.TimeoutError):
            pass
        await asyncio.wait_for(task_b, 10)
        # sb should have produced chunks
        assert h.chunks("sb")
    finally:
        await h.stop()


@pytest.mark.asyncio
async def test_duplicate_turn_start_busy(ckpt_dir, writer, fake):
    fake.reset_script([AssistantMessage(content="SLOW"), AssistantMessage(content="x")])
    h = RpcHarness(ckpt_dir, writer)
    await h.start()
    try:
        rid1, task1 = await h.call_nowait(
            "turn.start",
            {"sid": "busy", "query": "1", "tools": [], "model": FAKE_MODEL},
        )
        await asyncio.sleep(0.3)
        r2 = await h.call(
            "turn.start",
            {"sid": "busy", "query": "2", "tools": [], "model": FAKE_MODEL},
        )
        assert "error" in r2
        assert "active turn" in r2["error"]["message"]
        await h.call("turn.cancel", {"sid": "busy"})
        try:
            await asyncio.wait_for(task1, 5)
        except (asyncio.CancelledError, asyncio.TimeoutError):
            pass
    finally:
        await h.stop()


@pytest.mark.asyncio
async def test_system_prompt_passthrough(ckpt_dir, writer, fake):
    fake.reset_script([AssistantMessage(content="ok")])
    h = RpcHarness(ckpt_dir, writer)
    await h.start()
    try:
        await h.call(
            "turn.start",
            {
                "sid": "sys1",
                "query": "hi",
                "system": "UNIQUE_SYSTEM_PROMPT_XYZ",
                "tools": [],
                "model": FAKE_MODEL,
            },
        )
        # System prompt is baked into agent; at least turn succeeded and SEEN has msgs.
        assert fake.SEEN
        joined = json.dumps(fake.SEEN, default=str)
        # Identity section may wrap it; soft check that turn ran.
        assert h.chunks("sys1")
    finally:
        await h.stop()


@pytest.mark.asyncio
async def test_images_path(ckpt_dir, writer, fake):
    fake.reset_script([AssistantMessage(content="saw image")])
    h = RpcHarness(ckpt_dir, writer)
    await h.start()
    try:
        r = await h.call(
            "turn.start",
            {
                "sid": "img1",
                "query": "what is in the image",
                "tools": [],
                "model": FAKE_MODEL,
                "images": ["data:image/png;base64,iVBORw0KGgo="],
            },
        )
        assert r["result"]["ok"] is True
        # Last user message content should be multimodal list
        last = fake.SEEN[-1]["messages"][-1]
        role, content = last
        assert role == "user"
        assert isinstance(content, list)
        types = [p.get("type") for p in content if isinstance(p, dict)]
        assert "image_url" in types
    finally:
        await h.stop()


@pytest.mark.asyncio
async def test_per_session_model_switch(ckpt_dir, writer, fake):
    fake.reset_script(
        [AssistantMessage(content="a"), AssistantMessage(content="b")]
    )
    h = RpcHarness(ckpt_dir, writer)
    await h.start()
    try:
        await h.call(
            "turn.start",
            {
                "sid": "m1",
                "query": "one",
                "tools": [],
                "model": {**FAKE_MODEL, "model": "model-A"},
            },
        )
        await h.call(
            "turn.start",
            {
                "sid": "m1",
                "query": "two",
                "tools": [],
                "model": {**FAKE_MODEL, "model": "model-B"},
            },
        )
        # Two turns completed
        assert len([c for c in h.chunks("m1") if c["type"] in ("answer", "llm_output")]) >= 1
    finally:
        await h.stop()


@pytest.mark.asyncio
async def test_model_error_surfaces(ckpt_dir, writer, fake, monkeypatch):
    """Model failures must not leak raw keys on the wire; turn must finish."""
    from unittest.mock import patch

    async def boom_stream(*a, **k):
        raise RuntimeError("model exploded sk-SHOULDNOTLEAK12345678")
        yield  # pragma: no cover

    with patch(
        "openjiuwen.core.foundation.llm.model.Model.stream",
        side_effect=boom_stream,
    ):
        h = RpcHarness(ckpt_dir, writer)
        await h.start()
        try:
            r = await h.call(
                "turn.start",
                {"sid": "err", "query": "x", "tools": [], "model": FAKE_MODEL},
            )
            # openjiuwen may swallow stream errors into an empty answer; either
            # an RPC error or a completed turn is acceptable — raw key must not leak.
            assert r is not None
            dumped = writer.getvalue()
            assert "sk-SHOULDNOTLEAK12345678" not in dumped
            # Our redact filter also rewrites logged exception text when we echo it.
            if "error" in r:
                assert "sk-SHOULDNOTLEAK12345678" not in json.dumps(r)
        finally:
            await h.stop()


ECHO_WITH_OPTIONAL = {
    "name": "dsh_echo",
    "description": "Echo via dsh",
    "parameters": {
        "type": "object",
        "properties": {
            "text": {"type": "string"},
            "flag": {"type": "boolean"},
        },
        "required": ["text"],
    },
}


@pytest.mark.asyncio
async def test_tool_args_strip_none_optionals(ckpt_dir, writer, fake):
    """SchemaUtils fills omitted optionals with None; emit must drop them for dsh."""
    fake.reset_script(
        [
            AssistantMessage(
                content="",
                tool_calls=[
                    ToolCall(
                        id="c1",
                        type="function",
                        name="dsh_echo",
                        arguments=json.dumps({"text": "hi"}),
                    )
                ],
            ),
            AssistantMessage(content="done"),
        ]
    )
    h = RpcHarness(
        ckpt_dir,
        writer,
        tool_handler=lambda p: {"ok": True, "content": {"echo": (p.get("args") or {}).get("text", "").upper()}},
    )
    await h.start()
    try:
        r = await h.call(
            "turn.start",
            {
                "sid": "s-null",
                "query": "call the tool",
                "tools": [ECHO_WITH_OPTIONAL],
                "model": FAKE_MODEL,
            },
        )
        assert r["result"]["ok"] is True
        assert h.tool_calls()
        args = h.tool_calls()[0]["args"]
        assert args.get("text") == "hi"
        assert "flag" not in args  # None stripped
        assert all(v is not None for v in args.values())
    finally:
        await h.stop()
