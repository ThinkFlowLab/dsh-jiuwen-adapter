"""Per-session DeepAgent cache, tools, cancel, fork/delete/history."""
from __future__ import annotations

import asyncio
import logging
import os
import tempfile
import uuid
from pathlib import Path
from typing import Any, Awaitable, Callable, Dict, List, Optional

from openjiuwen.core.foundation.llm import (
    Model,
    ModelClientConfig,
    ModelRequestConfig,
)
from openjiuwen.core.foundation.tool import LocalFunction, ToolCard
from openjiuwen.core.runner import Runner
from openjiuwen.core.session.checkpointer import CheckpointerFactory
from openjiuwen.core.session.checkpointer.checkpointer import CheckpointerConfig
from openjiuwen.core.session.checkpointer.persistence import PersistenceCheckpointerProvider
from openjiuwen.core.single_agent.schema.agent_card import AgentCard
from openjiuwen.harness.cli.rails.tool_tracker import ToolTrackingRail
from openjiuwen.harness.factory import create_deep_agent

from . import fake_model

logger = logging.getLogger(__name__)

EmitFn = Callable[[str, dict], Awaitable[None]]
# emit(event_name, params) — unsolicited Py→Node events


def default_checkpoint_dir() -> Path:
    override = os.environ.get("DSH_JIUVEN_AC_DIR") or os.environ.get("AGENTCORE_CKPT_DIR")
    if override:
        return Path(override).expanduser()
    dsh_home = os.environ.get("DSH_HOME")
    if dsh_home:
        return Path(dsh_home).expanduser() / "jiuwen-adapter" / "ac"
    return Path("/tmp/dsh-jiuwen-ac")


def _chunk_type(ch: Any) -> Optional[str]:
    if isinstance(ch, dict):
        return ch.get("type")
    return getattr(ch, "type", None)


def _chunk_payload(ch: Any) -> Any:
    if isinstance(ch, dict):
        return ch.get("payload")
    return getattr(ch, "payload", None)


def _serialize_message(m: Any) -> dict:
    if hasattr(m, "model_dump"):
        try:
            data = m.model_dump(exclude_none=True)
            # Keep history compact and JSON-safe.
            out = {
                "role": data.get("role"),
                "content": data.get("content", ""),
            }
            if data.get("name"):
                out["name"] = data["name"]
            if data.get("tool_calls"):
                out["tool_calls"] = data["tool_calls"]
            if data.get("reasoning_content"):
                out["reasoning_content"] = data["reasoning_content"]
            return out
        except Exception:
            pass
    return {
        "role": getattr(m, "role", None),
        "content": getattr(m, "content", str(m)),
    }


def build_model(model_spec: dict) -> Model:
    """Build a Model from turn.start model spec. Never logs api keys."""
    provider = model_spec.get("provider") or "OpenAI"
    api_base = model_spec.get("api_base") or "http://127.0.0.1:9/v1"
    model_name = model_spec.get("model") or "fake-model"
    api_key_env = model_spec.get("api_key_env") or ""
    api_key = "sk-fake"
    if api_key_env:
        api_key = os.environ.get(api_key_env) or api_key
    elif model_spec.get("api_key"):
        # Accept but do not prefer; host should use api_key_env.
        api_key = model_spec["api_key"]

    if fake_model.should_use_fake(provider):
        fake_model.install_fake_model()
        provider = "OpenAI"

    # Map common lowercase aliases to ProviderType values.
    provider_map = {
        "openai": "OpenAI",
        "fake": "OpenAI",
        "dashscope": "DashScope",
        "openrouter": "OpenRouter",
        "siliconflow": "SiliconFlow",
    }
    client_provider = provider_map.get(str(provider).lower(), provider)

    req_kwargs = {"model_name": model_name}
    if model_spec.get("temperature") is not None:
        try:
            req_kwargs["temperature"] = float(model_spec["temperature"])
        except (TypeError, ValueError):
            pass
    if model_spec.get("max_tokens") is not None:
        try:
            req_kwargs["max_tokens"] = int(model_spec["max_tokens"])
        except (TypeError, ValueError):
            pass
    if model_spec.get("top_p") is not None:
        try:
            req_kwargs["top_p"] = float(model_spec["top_p"])
        except (TypeError, ValueError):
            pass
    return Model(
        model_client_config=ModelClientConfig(
            client_provider=client_provider,
            api_key=api_key,
            api_base=api_base,
            verify_ssl=False,
        ),
        model_config=ModelRequestConfig(**req_kwargs),
    )


class SessionManager:
    """Owns DeepAgent instances keyed by dsh session id."""

    def __init__(
        self,
        emit: EmitFn,
        *,
        checkpoint_dir: Optional[Path] = None,
        workspace_dir: Optional[Path] = None,
    ) -> None:
        self._emit = emit
        self._checkpoint_dir = Path(checkpoint_dir) if checkpoint_dir else default_checkpoint_dir()
        self._workspace_dir = (
            Path(workspace_dir) if workspace_dir else Path(tempfile.mkdtemp(prefix="dsh-ac-ws-"))
        )
        self._agents: Dict[str, Any] = {}
        self._tool_names: Dict[str, set[str]] = {}
        self._turn_tasks: Dict[str, asyncio.Task] = {}
        self._pending_tools: Dict[str, asyncio.Future] = {}
        self._pending_images: Dict[str, List[str]] = {}
        self._started = False
        self._checkpointer_ready = False

    @property
    def checkpoint_dir(self) -> Path:
        return self._checkpoint_dir

    async def start(self) -> None:
        if self._started:
            return
        self._checkpoint_dir.mkdir(parents=True, exist_ok=True)
        self._workspace_dir.mkdir(parents=True, exist_ok=True)
        await self._ensure_checkpointer()
        await Runner.start()
        self._started = True
        logger.warning(
            "SessionManager started checkpoint_dir=%s", self._checkpoint_dir
        )

    async def stop(self) -> None:
        for sid, task in list(self._turn_tasks.items()):
            if not task.done():
                task.cancel()
        self._turn_tasks.clear()
        for fut in list(self._pending_tools.values()):
            if not fut.done():
                fut.set_exception(asyncio.CancelledError())
        self._pending_tools.clear()
        self._agents.clear()
        if self._started:
            try:
                await Runner.stop()
            except Exception:
                logger.exception("Runner.stop failed")
        self._started = False

    async def _ensure_checkpointer(self) -> None:
        if self._checkpointer_ready:
            return
        PersistenceCheckpointerProvider()
        db_path = str(self._checkpoint_dir / "checkpoint")
        cp = await CheckpointerFactory.create(
            CheckpointerConfig(
                type="persistence",
                conf={"db_type": "sqlite", "db_path": db_path},
            )
        )
        CheckpointerFactory.set_default_checkpointer(cp)
        self._checkpointer_ready = True

    def _make_tool(self, sid: str, spec: dict) -> LocalFunction:
        name = spec["name"]
        description = spec.get("description") or ""
        parameters = spec.get("parameters") or {
            "type": "object",
            "properties": {},
        }
        card = ToolCard(
            name=name,
            description=description,
            input_params=parameters,
        )

        async def _rpc_func(**kwargs: Any) -> Any:
            call_id = uuid.uuid4().hex
            loop = asyncio.get_running_loop()
            fut: asyncio.Future = loop.create_future()
            self._pending_tools[call_id] = fut
            timeout_raw = os.environ.get("AGENTCORE_TOOL_TIMEOUT", "120")
            try:
                timeout = float(timeout_raw)
            except ValueError:
                timeout = 120.0
            try:
                await self._emit(
                    "tool.call",
                    {"callId": call_id, "name": name, "args": kwargs, "sid": sid},
                )
                try:
                    result = await asyncio.wait_for(fut, timeout=timeout)
                except asyncio.TimeoutError as exc:
                    if not fut.done():
                        fut.cancel()
                    raise TimeoutError(
                        f"tool callback timed out after {timeout}s: {name}"
                    ) from exc
            finally:
                self._pending_tools.pop(call_id, None)
            if not result.get("ok", True):
                content = result.get("content")
                raise RuntimeError(
                    content if isinstance(content, str) else str(content)
                )
            return result.get("content")

        return LocalFunction(card=card, func=_rpc_func)

    def _sync_tools(self, agent: Any, sid: str, tool_specs: List[dict]) -> None:
        wanted = {t["name"]: t for t in tool_specs if t.get("name")}
        current = self._tool_names.get(sid, set())
        to_remove = current - set(wanted)
        if to_remove:
            try:
                agent.ability_manager.remove_ability(list(to_remove))
            except Exception:
                logger.exception("remove_ability failed sid=%s", sid)
        for name, spec in wanted.items():
            if name in current:
                # Re-bind so the closure still points at this SessionManager.
                try:
                    agent.ability_manager.remove_ability(name)
                except Exception:
                    pass
            tool = self._make_tool(sid, spec)
            agent.ability_manager.add_ability(tool.card, tool)
        self._tool_names[sid] = set(wanted)

    def _ensure_agent(
        self,
        sid: str,
        model_spec: dict,
        system: Optional[str],
        tool_specs: List[dict],
        cwd: Optional[str] = None,
    ) -> Any:
        model = build_model(model_spec)
        ws = cwd or str(self._workspace_dir / sid)
        Path(ws).mkdir(parents=True, exist_ok=True)

        if sid in self._agents:
            agent = self._agents[sid]
            try:
                agent.react_agent.set_llm(model)
            except Exception:
                logger.exception("set_llm failed sid=%s", sid)
            if system:
                try:
                    # Hot-reload identity section from host system prompt.
                    import dataclasses
                    cfg = getattr(agent, "_deep_config", None)
                    if cfg is not None and hasattr(agent, "configure"):
                        agent.configure(dataclasses.replace(cfg, system_prompt=system))
                    elif hasattr(agent, "_hot_reload_system_prompt") and cfg is not None:
                        cfg.system_prompt = system
                        agent._hot_reload_system_prompt(cfg)
                except Exception:
                    logger.exception("system prompt reload failed sid=%s", sid)
            self._sync_tools(agent, sid, tool_specs)
            return agent

        tools = [self._make_tool(sid, t) for t in tool_specs if t.get("name")]
        # When the host supplies a system prompt, use prompt_mode=none so DeepAgent
        # identity/skills/memory sections do not stack on top of dsh's system text.
        prompt_mode = os.environ.get("AGENTCORE_PROMPT_MODE") or (
            "none" if system else "minimal"
        )
        agent = create_deep_agent(
            model,
            card=AgentCard(id=sid, name=f"dsh-{sid}"),
            system_prompt=system or "You are a helpful assistant.",
            tools=tools,
            rails=[ToolTrackingRail()],
            workspace=ws,
            enable_security_rail=False,
            enable_model_anomaly_detection_rail=False,
            prompt_mode=prompt_mode,
        )
        self._agents[sid] = agent
        self._tool_names[sid] = {t.card.name for t in tools}

        # Image window mutator (per-turn images held in _pending_images).
        async def img_mutator(_ctx, window):
            imgs = self._pending_images.pop(sid, None)
            if not imgs:
                return window
            msgs = list(window.context_messages)
            for i in range(len(msgs) - 1, -1, -1):
                m = msgs[i]
                if getattr(m, "role", None) == "user":
                    text = m.content if isinstance(m.content, str) else ""
                    msgs[i] = m.model_copy(
                        update={
                            "content": [{"type": "text", "text": text}]
                            + [
                                {"type": "image_url", "image_url": {"url": u}}
                                for u in imgs
                            ]
                        }
                    )
                    break
            return window.model_copy(update={"context_messages": msgs})

        # Register after ensure_initialized; defer until first turn.
        agent._dsh_img_mutator = img_mutator  # type: ignore[attr-defined]
        return agent

    async def _register_img_mutator(self, agent: Any) -> None:
        mutator = getattr(agent, "_dsh_img_mutator", None)
        if mutator is None or getattr(agent, "_dsh_img_mutator_registered", False):
            return
        await agent.ensure_initialized()
        agent.react_agent.context_engine.register_window_mutator(mutator)
        agent._dsh_img_mutator_registered = True  # type: ignore[attr-defined]

    async def resolve_tool_result(
        self, call_id: str, ok: bool, content: Any
    ) -> None:
        fut = self._pending_tools.get(call_id)
        if fut is None or fut.done():
            logger.warning("tool.result for unknown/finished callId=%s", call_id)
            return
        fut.set_result({"ok": ok, "content": content})

    async def turn_start(self, params: dict) -> dict:
        # openjiuwen may attach stdout handlers lazily — keep NDJSON wire clean.
        from .logutil import configure_logging
        configure_logging()
        if not params.get("sid"):
            raise ValueError("missing params: sid")
        if params.get("query") is None or params.get("query") == "":
            raise ValueError("missing params: query")
        sid = params["sid"]
        query = params["query"]
        system = params.get("system")
        tools = params.get("tools") or []
        model_spec = params.get("model") or {"provider": "fake", "model": "fake"}
        images = params.get("images") or []
        cwd = params.get("cwd")

        if sid in self._turn_tasks and not self._turn_tasks[sid].done():
            raise RuntimeError(f"session {sid} already has an active turn")

        agent = self._ensure_agent(sid, model_spec, system, tools, cwd=cwd)
        await self._register_img_mutator(agent)
        plan = params.get("plan")
        if plan:
            try:
                import dataclasses
                from openjiuwen.harness.schema.agent_mode import AgentMode
                cfg = getattr(agent, "_deep_config", None)
                if cfg is not None and hasattr(agent, "configure"):
                    agent.configure(dataclasses.replace(
                        cfg,
                        enable_plan_mode=True,
                        default_mode=AgentMode.PLAN,
                    ))
            except Exception:
                logger.exception("enable PLAN mode failed sid=%s", sid)
        if images:
            # Accept list of data URLs / paths.
            self._pending_images[sid] = list(images)

        async def _consume() -> None:
            inputs = {"query": query, "conversation_id": sid}
            async for ch in Runner.run_agent_streaming(
                agent, inputs, session=sid
            ):
                t = _chunk_type(ch)
                if t is None:
                    continue
                # Skip noisy tracer chunks.
                if t == "tracer_agent":
                    continue
                payload = _chunk_payload(ch)
                if hasattr(payload, "model_dump"):
                    try:
                        payload = payload.model_dump()
                    except Exception:
                        payload = str(payload)
                await self._emit("chunk", {"type": t, "payload": payload, "sid": sid})

        task = asyncio.create_task(_consume(), name=f"turn:{sid}")
        self._turn_tasks[sid] = task
        try:
            await task
        except asyncio.CancelledError:
            logger.warning("turn cancelled sid=%s", sid)
            raise
        finally:
            self._turn_tasks.pop(sid, None)
            self._pending_images.pop(sid, None)
        return {"ok": True}

    async def turn_cancel(self, params: dict) -> dict:
        sid = params["sid"]
        task = self._turn_tasks.get(sid)
        if task is None or task.done():
            return {"ok": True, "cancelled": False}
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        except Exception:
            logger.exception("error awaiting cancelled turn sid=%s", sid)
        return {"ok": True, "cancelled": True}

    async def session_fork(self, params: dict) -> dict:
        from_sid = params["from"]
        to_sid = params["to"]
        parent = self._agents.get(from_sid)
        if parent is None:
            # Create a blank parent shell so get_current_context can be attempted
            # after checkpointer restore — or just seed empty.
            messages: List[Any] = []
        else:
            try:
                messages = list(parent.get_current_context(from_sid) or [])
            except Exception:
                logger.exception("get_current_context failed from=%s", from_sid)
                messages = []

        # Child gets its own DeepAgent; seed history via create_new_context_engine.
        model_spec = params.get("model") or {"provider": "fake", "model": "fake"}
        system = params.get("system")
        tools = params.get("tools") or []
        child = self._ensure_agent(to_sid, model_spec, system, tools)
        await child.ensure_initialized()
        await child.create_new_context_engine(to_sid, messages=messages)
        return {"ok": True, "sid": to_sid, "seeded": len(messages)}

    async def session_delete(self, params: dict) -> dict:
        sid = params["sid"]
        # Cancel any in-flight turn first.
        await self.turn_cancel({"sid": sid})
        agent = self._agents.get(sid)
        try:
            await Runner.release(sid)
        except Exception:
            logger.exception("Runner.release failed sid=%s", sid)
        if agent is not None:
            try:
                await agent.react_agent.context_engine.clear_context(session_id=sid)
            except Exception:
                logger.exception("clear_context failed sid=%s", sid)
            try:
                agent.ability_manager.teardown_tools()
            except Exception:
                pass
        self._agents.pop(sid, None)
        self._tool_names.pop(sid, None)
        self._pending_images.pop(sid, None)
        return {"ok": True}

    async def session_history(self, params: dict) -> dict:
        sid = params["sid"]
        agent = self._agents.get(sid)
        if agent is None:
            return {"ok": True, "messages": []}
        try:
            msgs = agent.get_current_context(sid) or []
        except Exception as exc:
            logger.exception("get_current_context failed sid=%s", sid)
            return {"ok": False, "error": str(exc), "messages": []}
        return {
            "ok": True,
            "messages": [_serialize_message(m) for m in msgs],
        }
