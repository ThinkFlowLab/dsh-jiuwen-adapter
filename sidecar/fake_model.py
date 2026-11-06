"""Offline fake Model.stream/invoke for tests (no network, no real keys).

Enable with env ``AGENTCORE_FAKE_MODEL=1`` or a turn model provider named
``fake``. Tests push ``AssistantMessage`` instances onto ``SCRIPT``.
"""
from __future__ import annotations

import collections
import logging
from typing import Any, Deque, List, Optional
from unittest.mock import patch

from openjiuwen.core.foundation.llm import AssistantMessage, UsageMetadata
from openjiuwen.core.foundation.llm.schema.message_chunk import AssistantMessageChunk

logger = logging.getLogger(__name__)

SCRIPT: Deque[AssistantMessage] = collections.deque()
SEEN: List[dict] = []

_patches: list = []
_installed = False


async def fake_stream(*args: Any, messages=None, tools=None, model=None, **kwargs: Any):
    SEEN.append(
        {
            "messages": [
                (getattr(m, "role", None), getattr(m, "content", None))
                for m in (messages or [])
            ],
            "tools": sorted(
                [
                    getattr(t, "name", None)
                    or (
                        t.get("function", {}).get("name")
                        if isinstance(t, dict)
                        else None
                    )
                    for t in (tools or [])
                ]
            ),
            "model": getattr(model, "model_config", None)
            and getattr(model.model_config, "model_name", None),
        }
    )
    reply = SCRIPT.popleft() if SCRIPT else AssistantMessage(content="(default)")
    if getattr(reply, "content", None) == "SLOW":
        yield AssistantMessageChunk(content="part ")
        import asyncio

        await asyncio.sleep(30)
        yield AssistantMessageChunk(
            content="never",
            usage_metadata=UsageMetadata(
                model_name="fake", input_tokens=1, output_tokens=1, total_tokens=2
            ),
        )
        return
    if reply.reasoning_content:
        yield AssistantMessageChunk(
            content="", reasoning_content=reply.reasoning_content
        )
    yield AssistantMessageChunk(
        content=reply.content or "",
        tool_calls=reply.tool_calls or [],
        usage_metadata=UsageMetadata(
            model_name="fake", input_tokens=11, output_tokens=7, total_tokens=18
        ),
    )


async def fake_invoke(*args: Any, **kwargs: Any) -> AssistantMessage:
    return AssistantMessage(
        content="(invoke)",
        usage_metadata=UsageMetadata(model_name="fake"),
    )


def install_fake_model() -> None:
    """Patch Model.stream/invoke process-wide. Idempotent."""
    global _installed
    if _installed:
        return
    p_stream = patch(
        "openjiuwen.core.foundation.llm.model.Model.stream",
        side_effect=fake_stream,
    )
    p_invoke = patch(
        "openjiuwen.core.foundation.llm.model.Model.invoke",
        side_effect=fake_invoke,
    )
    p_stream.start()
    p_invoke.start()
    _patches.extend([p_stream, p_invoke])
    _installed = True
    logger.warning("AGENTCORE fake model installed (offline)")


def uninstall_fake_model() -> None:
    global _installed
    while _patches:
        p = _patches.pop()
        try:
            p.stop()
        except RuntimeError:
            pass
    _installed = False


def reset_script(messages: Optional[list] = None) -> None:
    SCRIPT.clear()
    SEEN.clear()
    if messages:
        SCRIPT.extend(messages)


def should_use_fake(provider: Optional[str] = None) -> bool:
    import os

    if os.environ.get("AGENTCORE_FAKE_MODEL", "").strip() in ("1", "true", "TRUE", "yes"):
        return True
    if provider and str(provider).lower() == "fake":
        return True
    return False
