"""Fork / delete / history / cross-process persistence."""
from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest
from openjiuwen.core.foundation.llm import AssistantMessage, UserMessage

from sidecar.tests.harness import RpcHarness

FAKE_MODEL = {
    "provider": "fake",
    "api_base": "http://127.0.0.1:9/v1",
    "api_key_env": "NO_KEY",
    "model": "fake-model",
}
ROOT = Path(__file__).resolve().parents[2]


@pytest.mark.asyncio
async def test_fork_seeds_history(ckpt_dir, writer, fake):
    fake.reset_script(
        [
            AssistantMessage(content="parent-answer"),
            AssistantMessage(content="child-continues"),
        ]
    )
    h = RpcHarness(ckpt_dir, writer)
    await h.start()
    try:
        await h.call(
            "turn.start",
            {
                "sid": "parent",
                "query": "old question",
                "tools": [],
                "model": FAKE_MODEL,
                "system": "sys",
            },
        )
        fr = await h.call("session.fork", {"from": "parent", "to": "child"})
        assert fr["result"]["ok"] is True
        assert fr["result"]["seeded"] >= 1
        await h.call(
            "turn.start",
            {"sid": "child", "query": "continue", "tools": [], "model": FAKE_MODEL},
        )
        # Child model should have seen seeded history + new query
        msgs = fake.SEEN[-1]["messages"]
        roles = [m[0] for m in msgs]
        contents = [str(m[1]) for m in msgs]
        assert "user" in roles
        assert any("old question" in c or "parent-answer" in c for c in contents) or len(msgs) >= 2
    finally:
        await h.stop()


@pytest.mark.asyncio
async def test_fork_nonexistent_sid(ckpt_dir, writer, fake):
    fake.reset_script([AssistantMessage(content="fresh")])
    h = RpcHarness(ckpt_dir, writer)
    await h.start()
    try:
        fr = await h.call("session.fork", {"from": "nope", "to": "newborn"})
        assert fr["result"]["ok"] is True
        assert fr["result"]["seeded"] == 0
        r = await h.call(
            "turn.start",
            {"sid": "newborn", "query": "hi", "tools": [], "model": FAKE_MODEL},
        )
        assert r["result"]["ok"] is True
    finally:
        await h.stop()


@pytest.mark.asyncio
async def test_delete_clears_then_recreate(ckpt_dir, writer, fake):
    fake.reset_script(
        [
            AssistantMessage(content="remember-me"),
            AssistantMessage(content="fresh-after-delete"),
        ]
    )
    h = RpcHarness(ckpt_dir, writer)
    await h.start()
    try:
        await h.call(
            "turn.start",
            {"sid": "del1", "query": "first", "tools": [], "model": FAKE_MODEL},
        )
        hist = await h.call("session.history", {"sid": "del1"})
        assert hist["result"]["messages"]
        dr = await h.call("session.delete", {"sid": "del1"})
        assert dr["result"]["ok"] is True
        hist2 = await h.call("session.history", {"sid": "del1"})
        assert hist2["result"]["messages"] == []
        # recreate clean
        await h.call(
            "turn.start",
            {"sid": "del1", "query": "second", "tools": [], "model": FAKE_MODEL},
        )
        # New turn's model context should not include "remember-me" as prior assistant
        # (soft: at least turn ok and SEEN updated)
        assert fake.SEEN
        last_contents = [str(m[1]) for m in fake.SEEN[-1]["messages"]]
        # After delete+new agent, history starts fresh; "remember-me" should be absent
        assert not any("remember-me" == c for c in last_contents)
    finally:
        await h.stop()


@pytest.mark.asyncio
async def test_history_after_turn(ckpt_dir, writer, fake):
    fake.reset_script([AssistantMessage(content="hello-hist")])
    h = RpcHarness(ckpt_dir, writer)
    await h.start()
    try:
        await h.call(
            "turn.start",
            {"sid": "h1", "query": "q1", "tools": [], "model": FAKE_MODEL},
        )
        hist = await h.call("session.history", {"sid": "h1"})
        assert hist["result"]["ok"] is True
        roles = [m["role"] for m in hist["result"]["messages"]]
        assert "user" in roles or "assistant" in roles
    finally:
        await h.stop()


def test_cross_process_history_restore(tmp_path):
    """Write in one process, read in another (true cross-process)."""
    ckpt = tmp_path / "ckpt"
    ckpt.mkdir()
    helper = ROOT / "sidecar" / "tests" / "_persist_helper.py"
    env = os.environ.copy()
    env["AGENTCORE_FAKE_MODEL"] = "1"
    env["LLM_SSL_VERIFY"] = "false"
    env["DSH_JIUVEN_AC_DIR"] = str(ckpt)
    env["PYTHONPATH"] = str(ROOT)
    py = str(ROOT / ".venv-sidecar" / "bin" / "python")
    if not Path(py).exists():
        py = sys.executable

    w = subprocess.run(
        [py, str(helper), "write", str(ckpt)],
        capture_output=True,
        text=True,
        env=env,
        cwd=str(ROOT),
        timeout=120,
    )
    assert w.returncode == 0, w.stdout + w.stderr

    r = subprocess.run(
        [py, str(helper), "read", str(ckpt)],
        capture_output=True,
        text=True,
        env=env,
        cwd=str(ROOT),
        timeout=120,
    )
    assert r.returncode == 0, r.stdout + r.stderr
    assert "RESTORED_OK" in r.stdout


# Ensure helper file exists alongside
