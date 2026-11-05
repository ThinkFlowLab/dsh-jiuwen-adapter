"""Per-session DeepAgent cache, tools, cancel, fork/delete/history."""
from __future__ import annotations

import asyncio
import hashlib
import json
import time
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

    req_kwargs: dict = {"model_name": model_name}
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
    # Reasoning / thinking: provider-neutral. Default disabled to match Gateway
    # chat turns (Volcengine seed → reasoning_effort=minimal). Never log keys.
    reasoning = model_spec.get("reasoning")
    if isinstance(reasoning, dict) and reasoning.get("mode"):
        mode = str(reasoning.get("mode")).lower()
        req_kwargs["reasoning"] = {
            "mode": "enabled" if mode in ("enabled", "on", "true") else "disabled"
        }
        if reasoning.get("effort"):
            req_kwargs["reasoning"]["effort"] = str(reasoning["effort"])
    elif model_spec.get("reasoning_mode"):
        mode = str(model_spec["reasoning_mode"]).lower()
        req_kwargs["reasoning"] = {
            "mode": "enabled" if mode in ("enabled", "on", "true") else "disabled"
        }
    else:
        req_kwargs["reasoning"] = {"mode": "disabled"}

    client_kwargs: dict = {
        "client_provider": client_provider,
        "api_key": api_key,
        "api_base": api_base,
        "verify_ssl": False,
    }
    endpoint_profile = model_spec.get("endpoint_profile") or os.environ.get("ENDPOINT_PROFILE")
    if endpoint_profile:
        client_kwargs["endpoint_profile"] = str(endpoint_profile)
    return Model(
        model_client_config=ModelClientConfig(**client_kwargs),
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
            # LocalFunction/SchemaUtils fills omitted optionals with None; dsh rejects null.
            clean_args = {k: v for k, v in kwargs.items() if v is not None}
            try:
                await self._emit(
                    "tool.call",
                    {"callId": call_id, "name": name, "args": clean_args, "sid": sid},
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

    @staticmethod
    def _tools_fingerprint(tool_specs: List[dict]) -> str:
        """Stable hash of tool name+description+parameters; skip rebind when unchanged."""
        items = []
        for t in tool_specs:
            name = t.get("name")
            if not name:
                continue
            items.append((
                name,
                t.get("description") or "",
                json.dumps(t.get("parameters") or {}, sort_keys=True, ensure_ascii=False),
            ))
        items.sort(key=lambda x: x[0])
        blob = json.dumps(items, ensure_ascii=False, separators=(",", ":"))
        return hashlib.sha256(blob.encode()).hexdigest()

    @staticmethod
    def _model_fingerprint(model_spec: dict) -> str:
        keys = ("provider", "api_base", "model", "api_key_env", "temperature", "max_tokens", "top_p", "endpoint_profile")
        slim = {k: model_spec.get(k) for k in keys}
        slim["reasoning"] = model_spec.get("reasoning") or model_spec.get("reasoning_mode")
        return hashlib.sha256(
            json.dumps(slim, sort_keys=True, ensure_ascii=False, default=str).encode()
        ).hexdigest()

    def _sync_tools(self, agent: Any, sid: str, tool_specs: List[dict]) -> dict:
        """Add/remove tools. Skip full rebind when the tool set fingerprint is unchanged.
        Returns timing stats for phase profiling.
        """
        t0 = time.perf_counter()
        fp = self._tools_fingerprint(tool_specs)
        prev_fp = getattr(self, "_tool_fps", {}).get(sid)
        if prev_fp == fp and sid in self._tool_names:
            return {"skipped": True, "ms": round((time.perf_counter() - t0) * 1000, 2), "n": len(self._tool_names[sid])}
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
                # Spec may have changed even if name stayed — re-bind this one.
                try:
                    agent.ability_manager.remove_ability(name)
                except Exception:
                    pass
            tool = self._make_tool(sid, spec)
            agent.ability_manager.add_ability(tool.card, tool)
        self._tool_names[sid] = set(wanted)
        if not hasattr(self, "_tool_fps"):
            self._tool_fps: Dict[str, str] = {}
        self._tool_fps[sid] = fp
        return {"skipped": False, "ms": round((time.perf_counter() - t0) * 1000, 2), "n": len(wanted)}

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
        phases: Dict[str, Any] = {}

        if sid in self._agents:
            agent = self._agents[sid]
            mfp = self._model_fingerprint(model_spec)
            if not hasattr(self, "_model_fps"):
                self._model_fps: Dict[str, str] = {}
            if self._model_fps.get(sid) != mfp:
                t0 = time.perf_counter()
                try:
                    agent.react_agent.set_llm(model)
                except Exception:
                    logger.exception("set_llm failed sid=%s", sid)
                phases["set_llm_ms"] = round((time.perf_counter() - t0) * 1000, 2)
                self._model_fps[sid] = mfp
            else:
                phases["set_llm_ms"] = 0
            if system:
                if not hasattr(self, "_system_fps"):
                    self._system_fps: Dict[str, str] = {}
                sfp = hashlib.sha256(system.encode()).hexdigest()
                if self._system_fps.get(sid) != sfp:
                    t0 = time.perf_counter()
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
                    phases["system_reload_ms"] = round((time.perf_counter() - t0) * 1000, 2)
                    self._system_fps[sid] = sfp
                else:
                    phases["system_reload_ms"] = 0
            phases["tools"] = self._sync_tools(agent, sid, tool_specs)
            agent._dsh_last_phases = phases  # type: ignore[attr-defined]
            return agent

        tools = [self._make_tool(sid, t) for t in tool_specs if t.get("name")]
        # When the host supplies a system prompt, use prompt_mode=none so DeepAgent
        # identity/skills/memory sections do not stack on top of dsh's system text.
        prompt_mode = os.environ.get("AGENTCORE_PROMPT_MODE") or (
            "none" if system else "minimal"
        )
        # Task/subagent loop is opt-in: enabling it registers openjiuwen TaskTool
        # alongside LocalFunction host tools. Default off keeps dsh plugin tool
        # hooks as the single execution path (no double-exec / bypass).
        task_loop = os.environ.get("AGENTCORE_TASK_LOOP", "").strip() == "1"
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
            enable_task_loop=task_loop,
            enable_async_subagent=task_loop,
            add_general_purpose_agent=task_loop,
            parallel_tool_calls=True,
        )
        self._agents[sid] = agent
        self._tool_names[sid] = {t.card.name for t in tools}
        if not hasattr(self, "_tool_fps"):
            self._tool_fps = {}
        if not hasattr(self, "_model_fps"):
            self._model_fps = {}
        if not hasattr(self, "_system_fps"):
            self._system_fps = {}
        self._tool_fps[sid] = self._tools_fingerprint(tool_specs)
        self._model_fps[sid] = self._model_fingerprint(model_spec)
        if system:
            self._system_fps[sid] = hashlib.sha256(system.encode()).hexdigest()
        agent._dsh_last_phases = {"created": True, "tools": {"n": len(tools)}}  # type: ignore[attr-defined]

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

        t_ensure = time.perf_counter()
        agent = self._ensure_agent(sid, model_spec, system, tools, cwd=cwd)
        ensure_ms = round((time.perf_counter() - t_ensure) * 1000, 2)
        phases = dict(getattr(agent, "_dsh_last_phases", {}) or {})
        phases["ensure_ms"] = ensure_ms
        await self._emit("chunk", {"type": "adapter_phase", "payload": phases, "sid": sid})
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

    async def session_compact(self, params: dict) -> dict:
        """Rebuild context engine for sid — dsh /jiuwen compact parity.

        Keeps DeepAgent + LocalFunction tools (plugin compat). Does not enable
        agent-core memory rails; host memory plugins stay authoritative.
        """
        sid = params["sid"]
        agent = self._agents.get(sid)
        if agent is None:
            return {"ok": True, "compacted": False, "reason": "no-agent"}
        keep = int(params.get("keep_last") or 0)
        messages: List[Any] = []
        try:
            messages = list(agent.get_current_context(sid) or [])
        except Exception:
            logger.exception("compact get_current_context failed sid=%s", sid)
            messages = []
        if keep > 0 and messages:
            messages = messages[-keep:]
        else:
            messages = []
        try:
            await agent.create_new_context_engine(sid, messages=messages)
        except Exception:
            logger.exception("compact create_new_context_engine failed sid=%s", sid)
            return {"ok": False, "compacted": False, "error": "context-rebuild-failed"}
        return {"ok": True, "compacted": True, "kept": len(messages)}

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
        for store in ("_tool_fps", "_model_fps", "_system_fps"):
            d = getattr(self, store, None)
            if isinstance(d, dict):
                d.pop(sid, None)
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
