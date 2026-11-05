"""Extra unit tests targeting uncovered sidecar branches (≥90% gate)."""
from __future__ import annotations

import asyncio
import io
import json
import logging
import os
import subprocess
import sys
from pathlib import Path
from unittest.mock import patch

import pytest
from openjiuwen.core.foundation.llm import AssistantMessage

from sidecar import fake_model
from sidecar.redact import RedactFilter, redact_obj
from sidecar.server import NdjsonServer, configure_logging, run_stdio
from sidecar.session_manager import (
    SessionManager,
    _chunk_payload,
    _chunk_type,
    _serialize_message,
    build_model,
    default_checkpoint_dir,
)
from sidecar.tests.harness import RpcHarness

ROOT = Path(__file__).resolve().parents[2]
FAKE_MODEL = {"provider": "fake", "model": "fake-model", "api_base": "http://127.0.0.1:9/v1"}


def test_default_checkpoint_dir_branches(monkeypatch, tmp_path):
    monkeypatch.delenv("DSH_JIUVEN_AC_DIR", raising=False)
    monkeypatch.delenv("AGENTCORE_CKPT_DIR", raising=False)
    monkeypatch.delenv("DSH_HOME", raising=False)
    assert default_checkpoint_dir() == Path("/tmp/dsh-jiuwen-ac")
    monkeypatch.setenv("DSH_HOME", str(tmp_path / "home"))
    assert default_checkpoint_dir() == tmp_path / "home" / "jiuwen-adapter" / "ac"
    monkeypatch.setenv("AGENTCORE_CKPT_DIR", str(tmp_path / "ckpt"))
    assert default_checkpoint_dir() == tmp_path / "ckpt"
    monkeypatch.setenv("DSH_JIUVEN_AC_DIR", str(tmp_path / "ac2"))
    assert default_checkpoint_dir() == tmp_path / "ac2"


def test_chunk_helpers_and_serialize():
    assert _chunk_type({"type": "x"}) == "x"
    assert _chunk_payload({"payload": 1}) == 1

    class Obj:
        type = "t"
        payload = {"a": 1}

    assert _chunk_type(Obj()) == "t"
    assert _chunk_payload(Obj()) == {"a": 1}

    class Dump:
        def model_dump(self, exclude_none=True):
            return {
                "role": "assistant",
                "content": "c",
                "name": "n",
                "tool_calls": [{"id": "1"}],
                "reasoning_content": "r",
            }

    s = _serialize_message(Dump())
    assert s["role"] == "assistant" and s["name"] == "n" and s["tool_calls"]

    class BadDump:
        role = "user"
        content = "hi"

        def model_dump(self, exclude_none=True):
            raise RuntimeError("nope")

    assert _serialize_message(BadDump())["content"] == "hi"


def test_build_model_and_fake_flags(monkeypatch):
    monkeypatch.setenv("AGENTCORE_FAKE_MODEL", "1")
    m = build_model({"provider": "OpenAI", "model": "m", "api_key_env": "MISSING_KEY_XYZ"})
    assert m is not None
    monkeypatch.delenv("AGENTCORE_FAKE_MODEL", raising=False)
    assert fake_model.should_use_fake("fake") is True
    assert fake_model.should_use_fake("OpenAI") is False
    m2 = build_model({"provider": "fake", "model": "m", "api_key": "sk-direct"})
    assert m2 is not None
    m3 = build_model({"provider": "dashscope", "model": "qwen"})
    assert m3 is not None


def test_fake_model_slow_and_uninstall(fake):
    fake.reset_script([AssistantMessage(content="SLOW")])
    # uninstall / reinstall
    fake.uninstall_fake_model()
    assert fake._installed is False
    fake.install_fake_model()
    fake.install_fake_model()  # idempotent
    fake.reset_script([AssistantMessage(content="hi")])


def test_configure_logging_bad_level_and_existing_handlers():
    configure_logging("NOTALEVEL")
    # existing handlers branch
    configure_logging("WARNING")
    configure_logging("DEBUG")


def test_redact_filter_dict_and_tuple_args():
    filt = RedactFilter()
    rec = logging.LogRecord(
        "n", logging.WARNING, __file__, 1, "api_key=%s", ("sk-ABCDEFGHIJKLMNOP",), None
    )
    assert filt.filter(rec) is True
    rec2 = logging.LogRecord(
        "n", logging.WARNING, __file__, 1, "%(k)s", None, None
    )
    rec2.args = {"k": "sk-ABCDEFGHIJKLMNOP"}
    assert filt.filter(rec2) is True
    assert redact_obj(["sk-ABCDEFGHIJKLMNOP"])[0] == "sk-***"


@pytest.mark.asyncio
async def test_server_run_with_stream_reader(ckpt_dir, writer, fake, monkeypatch):
    fake.reset_script([AssistantMessage(content="ok")])
    reader = asyncio.StreamReader()
    server = NdjsonServer(reader=reader, writer_file=writer, checkpoint_dir=ckpt_dir)
    # Queue lines then EOF
    async def feeder():
        await asyncio.sleep(0.05)
        reader.feed_data(
            (json.dumps({"id": 1, "method": "ping", "params": {}}) + "\n").encode()
        )
        reader.feed_data(b"not-json\n")
        reader.feed_data(b"42\n")  # non-object
        reader.feed_data(b"\n")
        reader.feed_data(
            (
                json.dumps(
                    {
                        "id": 2,
                        "method": "turn.start",
                        "params": {
                            "sid": "run1",
                            "query": "hi",
                            "tools": [],
                            "model": FAKE_MODEL,
                        },
                    }
                )
                + "\n"
            ).encode()
        )
        await asyncio.sleep(0.3)
        reader.feed_data(
            (json.dumps({"id": 3, "method": "shutdown", "params": {}}) + "\n").encode()
        )
        await asyncio.sleep(0.2)
        reader.feed_eof()

    feeder_task = asyncio.create_task(feeder())
    rc = await asyncio.wait_for(server.run(), timeout=30)
    await feeder_task
    assert rc == 0
    lines = writer.lines()
    assert any(l.get("id") == 1 and l.get("result", {}).get("pong") for l in lines)


@pytest.mark.asyncio
async def test_session_manager_stop_cancels_pending(ckpt_dir, fake):
    events = []

    async def emit(e, p):
        events.append((e, p))

    mgr = SessionManager(emit=emit, checkpoint_dir=ckpt_dir)
    await mgr.start()
    # Double start is no-op
    await mgr.start()
    # Plant a pending tool future and a fake turn task
    loop = asyncio.get_running_loop()
    fut = loop.create_future()
    mgr._pending_tools["x"] = fut

    async def sleeper():
        await asyncio.sleep(60)

    t = asyncio.create_task(sleeper())
    mgr._turn_tasks["s"] = t
    await mgr.stop()
    assert fut.done() or fut.cancelled()
    assert t.cancelled() or t.done()
    # stop again
    await mgr.stop()


@pytest.mark.asyncio
async def test_tool_sync_on_second_turn(ckpt_dir, writer, fake):
    fake.reset_script(
        [AssistantMessage(content="one"), AssistantMessage(content="two")]
    )
    tool_a = {
        "name": "dsh_echo",
        "description": "e",
        "parameters": {
            "type": "object",
            "properties": {"text": {"type": "string"}},
            "required": ["text"],
        },
    }
    tool_b = {
        "name": "dsh_other",
        "description": "o",
        "parameters": {"type": "object", "properties": {}},
    }
    h = RpcHarness(ckpt_dir, writer)
    await h.start()
    try:
        await h.call(
            "turn.start",
            {
                "sid": "sync1",
                "query": "a",
                "tools": [tool_a],
                "model": FAKE_MODEL,
            },
        )
        # Replace tools on next turn
        await h.call(
            "turn.start",
            {
                "sid": "sync1",
                "query": "b",
                "tools": [tool_b],
                "model": FAKE_MODEL,
            },
        )
        assert "dsh_other" in h.mgr._tool_names["sync1"]
        assert "dsh_echo" not in h.mgr._tool_names["sync1"]
    finally:
        await h.stop()


@pytest.mark.asyncio
async def test_invalid_tool_timeout_env(ckpt_dir, writer, fake, monkeypatch):
    monkeypatch.setenv("AGENTCORE_TOOL_TIMEOUT", "not-a-float")
    fake.reset_script([AssistantMessage(content="ok")])
    h = RpcHarness(ckpt_dir, writer)
    await h.start()
    try:
        r = await h.call(
            "turn.start",
            {"sid": "tto", "query": "q", "tools": [], "model": FAKE_MODEL},
        )
        assert r["result"]["ok"] is True
    finally:
        await h.stop()


@pytest.mark.asyncio
async def test_cancel_error_path_and_history_exception(ckpt_dir, writer, fake):
    h = RpcHarness(ckpt_dir, writer)
    await h.start()
    try:
        # history when agent exists but get_current_context fails
        fake.reset_script([AssistantMessage(content="x")])
        await h.call(
            "turn.start",
            {"sid": "hx", "query": "q", "tools": [], "model": FAKE_MODEL},
        )
        agent = h.mgr._agents["hx"]

        def boom(*a, **k):
            raise RuntimeError("ctx fail")

        with patch.object(agent, "get_current_context", side_effect=boom):
            r = await h.call("session.history", {"sid": "hx"})
            assert r["result"]["ok"] is False
    finally:
        await h.stop()


def test_main_module_entry(tmp_path, monkeypatch):
    """Cover sidecar.__main__.main without hanging on real stdin."""
    monkeypatch.setenv("DSH_JIUVEN_AC_DIR", str(tmp_path / "ac"))
    monkeypatch.setenv("AGENTCORE_FAKE_MODEL", "1")

    async def fake_run(checkpoint_dir=None, writer_file=None):
        assert checkpoint_dir is not None
        return 0

    import sidecar.__main__ as mainmod

    monkeypatch.setattr("sidecar.server.run_stdio", fake_run)
    with pytest.raises(SystemExit) as ei:
        mainmod.main()
    assert ei.value.code == 0


@pytest.mark.asyncio
async def test_server_stdin_thread_path(ckpt_dir, writer, fake, monkeypatch):
    """Cover NdjsonServer._read_lines fallback that drains sys.stdin."""
    fake.reset_script([AssistantMessage(content="ok")])
    payload = [
        json.dumps({"id": 1, "method": "ping", "params": {}}) + "\n",
        json.dumps({"id": 2, "method": "shutdown", "params": {}}) + "\n",
    ]

    class FakeStdin:
        def __iter__(self):
            return iter(payload)

    monkeypatch.setattr(sys, "stdin", FakeStdin())
    server = NdjsonServer(writer_file=writer, checkpoint_dir=ckpt_dir)
    rc = await asyncio.wait_for(server.run(), timeout=30)
    assert rc == 0
    assert any(l.get("id") == 1 for l in writer.lines())


@pytest.mark.asyncio
async def test_fake_stream_slow_branch(fake):
    fake.reset_script([AssistantMessage(content="SLOW")])
    chunks = []

    async def run():
        agen = fake.fake_stream(messages=[])
        async def consume():
            async for ch in agen:
                chunks.append(ch)
        task = asyncio.create_task(consume())
        await asyncio.sleep(0.05)
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

    await run()
    assert chunks  # got at least the first "part " chunk


@pytest.mark.asyncio
async def test_run_stdio_wrapper(tmp_path, monkeypatch, fake):
    # Avoid blocking on real stdin: patch NdjsonServer.run
    async def fake_run(self):
        return 0

    with patch.object(NdjsonServer, "run", fake_run):
        rc = await run_stdio(checkpoint_dir=tmp_path / "ac")
        assert rc == 0


@pytest.mark.asyncio
async def test_injected_session_manager_emit_bind(ckpt_dir, writer, fake):
    async def noop(e, p):
        return None

    mgr = SessionManager(emit=noop, checkpoint_dir=ckpt_dir)
    # Simulate missing emit
    mgr._emit = None  # type: ignore
    server = NdjsonServer(
        writer_file=writer, checkpoint_dir=ckpt_dir, session_manager=mgr
    )
    assert callable(server.manager._emit)


@pytest.mark.asyncio
async def test_fork_get_context_failure(ckpt_dir, writer, fake):
    fake.reset_script([AssistantMessage(content="p"), AssistantMessage(content="c")])
    h = RpcHarness(ckpt_dir, writer)
    await h.start()
    try:
        await h.call(
            "turn.start",
            {"sid": "fp", "query": "q", "tools": [], "model": FAKE_MODEL},
        )
        agent = h.mgr._agents["fp"]
        with patch.object(agent, "get_current_context", side_effect=RuntimeError("boom")):
            fr = await h.call("session.fork", {"from": "fp", "to": "fc"})
            assert fr["result"]["ok"] is True
            assert fr["result"]["seeded"] == 0
    finally:
        await h.stop()


@pytest.mark.asyncio
async def test_delete_release_and_clear_failures(ckpt_dir, writer, fake):
    fake.reset_script([AssistantMessage(content="x")])
    h = RpcHarness(ckpt_dir, writer)
    await h.start()
    try:
        await h.call(
            "turn.start",
            {"sid": "df", "query": "q", "tools": [], "model": FAKE_MODEL},
        )
        with patch("sidecar.session_manager.Runner.release", side_effect=RuntimeError("rel")):
            agent = h.mgr._agents["df"]
            with patch.object(
                agent.react_agent.context_engine,
                "clear_context",
                side_effect=RuntimeError("clr"),
            ):
                with patch.object(
                    agent.ability_manager, "teardown_tools", side_effect=RuntimeError("td")
                ):
                    r = await h.call("session.delete", {"sid": "df"})
                    assert r["result"]["ok"] is True
    finally:
        await h.stop()


@pytest.mark.asyncio
async def test_turn_cancel_await_exception(ckpt_dir, writer, fake):
    h = RpcHarness(ckpt_dir, writer)
    await h.start()
    try:
        async def boom():
            await asyncio.sleep(0.01)
            raise RuntimeError("turn boom")

        t = asyncio.create_task(boom())
        h.mgr._turn_tasks["zz"] = t
        await asyncio.sleep(0.05)
        # task already failed; cancel should still be ok
        r = await h.call("turn.cancel", {"sid": "zz"})
        assert r["result"]["ok"] is True
    finally:
        await h.stop()


def test_build_model_temperature_limits(monkeypatch):
    monkeypatch.delenv("AGENTCORE_FAKE_MODEL", raising=False)
    m = build_model({
        "provider": "fake",
        "model": "m",
        "temperature": 0.3,
        "max_tokens": 64,
        "top_p": 0.8,
        "api_key": "sk-test",
    })
    assert m.model_config.temperature == 0.3
    assert m.model_config.max_tokens == 64
    assert m.model_config.top_p == 0.8
    # bad values are ignored
    m2 = build_model({
        "provider": "fake",
        "model": "m",
        "temperature": "nope",
        "max_tokens": "x",
        "top_p": object(),
        "api_key": "sk-test",
    })
    assert m2 is not None


@pytest.mark.asyncio
async def test_prompt_mode_none_when_system_provided(ckpt_dir, writer, fake, monkeypatch):
    """Host system prompt → prompt_mode=none so DeepAgent identity sections do not stack."""
    monkeypatch.delenv("AGENTCORE_PROMPT_MODE", raising=False)
    fake.reset_script([AssistantMessage(content="ok")])
    h = RpcHarness(ckpt_dir, writer)
    await h.start()
    try:
        await h.call(
            "turn.start",
            {
                "sid": "pm1",
                "query": "hi",
                "tools": [],
                "model": {"provider": "fake", "model": "m", "api_key": "sk"},
                "system": "HOST SYSTEM ONLY",
            },
        )
        # Reach into SessionManager via server
        agent = h.mgr._agents["pm1"]
        cfg = getattr(agent, "_deep_config", None)
        assert cfg is not None
        assert cfg.prompt_mode == "none"
        assert "HOST SYSTEM ONLY" in (cfg.system_prompt or "")
    finally:
        await h.stop()


@pytest.mark.asyncio
async def test_plan_flag_enables_plan_mode(ckpt_dir, writer, fake):
    fake.reset_script([AssistantMessage(content="plan")])
    h = RpcHarness(ckpt_dir, writer)
    await h.start()
    try:
        await h.call(
            "turn.start",
            {
                "sid": "plan1",
                "query": "plan this",
                "tools": [],
                "model": {"provider": "fake", "model": "m", "api_key": "sk"},
                "system": "sys",
                "plan": True,
            },
        )
        agent = h.mgr._agents["plan1"]
        cfg = getattr(agent, "_deep_config", None)
        assert cfg is not None
        assert cfg.enable_plan_mode is True
    finally:
        await h.stop()

import pytest
from sidecar.session_manager import SessionManager

@pytest.mark.asyncio
async def test_sync_tools_skips_unchanged_fingerprint(monkeypatch):
    emits = []
    async def emit(ev, params):
        emits.append((ev, params))
    sm = SessionManager(emit)
    await sm.start()
    try:
        specs = [
            {"name": "read", "description": "r", "parameters": {"type": "object", "properties": {}}},
            {"name": "write", "description": "w", "parameters": {"type": "object", "properties": {}}},
        ]
        agent = sm._ensure_agent("s-fp", {"provider": "fake", "model": "fake"}, "sys", specs)
        n_add = 0
        orig_add = agent.ability_manager.add_ability
        def counting_add(*a, **k):
            nonlocal n_add
            n_add += 1
            return orig_add(*a, **k)
        agent.ability_manager.add_ability = counting_add
        # Second ensure with same tools+model+system must skip tool rebind
        sm._ensure_agent("s-fp", {"provider": "fake", "model": "fake"}, "sys", specs)
        assert n_add == 0
        phases = getattr(agent, "_dsh_last_phases", {})
        assert phases.get("tools", {}).get("skipped") is True
        # Changing a description forces rebind
        specs2 = [
            {"name": "read", "description": "r2", "parameters": {"type": "object", "properties": {}}},
            {"name": "write", "description": "w", "parameters": {"type": "object", "properties": {}}},
        ]
        sm._ensure_agent("s-fp", {"provider": "fake", "model": "fake"}, "sys", specs2)
        assert n_add >= 1
        assert getattr(agent, "_dsh_last_phases", {}).get("tools", {}).get("skipped") is False
    finally:
        await sm.stop()
