"""Subprocess helper for cross-process checkpointer restore."""
from __future__ import annotations

import asyncio
import os
import sys
import tempfile
from pathlib import Path

os.environ.setdefault("AGENTCORE_FAKE_MODEL", "1")
os.environ.setdefault("LLM_SSL_VERIFY", "false")

from openjiuwen.core.foundation.llm import AssistantMessage  # noqa: E402

from sidecar import fake_model  # noqa: E402
from sidecar.session_manager import SessionManager  # noqa: E402


async def _emit(event, params):
    return None


async def write(ckpt: Path):
    fake_model.install_fake_model()
    fake_model.reset_script([AssistantMessage(content="remember-me")])
    mgr = SessionManager(emit=_emit, checkpoint_dir=ckpt)
    await mgr.start()
    try:
        await mgr.turn_start(
            {
                "sid": "p9",
                "query": "first msg",
                "tools": [],
                "model": {"provider": "fake", "model": "fake-model"},
                "system": "sys",
            }
        )
    finally:
        await mgr.stop()
    print("WRITE_OK")


async def read(ckpt: Path):
    fake_model.install_fake_model()
    fake_model.reset_script([AssistantMessage(content="ok")])
    mgr = SessionManager(emit=_emit, checkpoint_dir=ckpt)
    await mgr.start()
    try:
        await mgr.turn_start(
            {
                "sid": "p9",
                "query": "second msg",
                "tools": [],
                "model": {"provider": "fake", "model": "fake-model"},
                "system": "sys",
            }
        )
        msgs = fake_model.SEEN[-1]["messages"]
        flat = " | ".join(f"{r}:{c}" for r, c in msgs)
        print("SEEN:", flat)
        if any("remember-me" in str(c) or "first msg" in str(c) for _, c in msgs):
            print("RESTORED_OK")
        else:
            print("RESTORED_MISS")
            sys.exit(2)
    finally:
        await mgr.stop()


def main():
    mode, ckpt = sys.argv[1], Path(sys.argv[2])
    if mode == "write":
        asyncio.run(write(ckpt))
    elif mode == "read":
        asyncio.run(read(ckpt))
    else:
        raise SystemExit(f"unknown mode {mode}")


if __name__ == "__main__":
    main()
