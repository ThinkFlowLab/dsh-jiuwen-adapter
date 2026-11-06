"""Opt-in openjiuwen agent-core capabilities wired into the dsh adapter sidecar.

Everything here is driven by the ``features`` object on ``turn.start`` (built by the
Node side from ``agentcore`` plugin config). With no features, the agent is built
exactly as before (host tools only, ``prompt_mode=none``).

Invariants kept for dsh plugin compatibility:
  * host (dsh) tools stay LocalFunctions routed to ``ctx.tools.execute``;
  * any *native* tool that touches files, shell, network or MCP goes through
    :class:`DshHostGateRail`, which asks dsh (``host.request kind=permission``)
    before every call and fails closed;
  * subagents reuse the same host LocalFunctions (no second execution path);
  * agent-core state lives under the adapter data dir, never in the project dir.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import shutil
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable, Dict, Iterable, List, Optional, Set

logger = logging.getLogger(__name__)

HostRequest = Callable[[str, str, dict], Awaitable[Any]]
# host_request(sid, kind, payload) -> result object from Node (tool.result content)

# Native tools that only touch agent-core's own state under the adapter data dir
# (todo files, memory files, skill copies, subagent bookkeeping, tool search).
# Everything else that is not a host tool is gated by dsh.
INTERNAL_TOOLS: Set[str] = {
    "skill_tool", "list_skill",
    "todo_create", "todo_list", "todo_get", "todo_modify",
    "memory_search", "memory_get", "write_memory", "edit_memory", "read_memory",
    "coding_memory_search", "coding_memory_read", "coding_memory_write", "coding_memory_edit",
    "task_tool", "sessions_list", "sessions_spawn", "sessions_send", "sessions_history", "sessions_cancel",
    "tool_search", "load_tools", "search_tools", "list_tools",
    "ask_user", "enter_plan_mode", "exit_plan_mode", "switch_mode",
    "knowledge_search",
}

# Prompt sections a capability rail may add. In prompt_mode=none (host system
# prompt present) openjiuwen renders identity only; the bridge also renders these
# when — and only when — an enabled rail registered them.
CAPABILITY_SECTIONS: Set[str] = {
    "skills", "todo", "memory", "daily_memory_context", "external_memory", "coding_memory",
    "task_tool", "subagent_tools", "session_tools", "heartbeat", "progressive_tool_rules",
    "tool_navigation", "safety", "completion_signal",
}

_BRIDGE_INSTALLED = False


def install_prompt_bridge() -> None:
    """Let capability sections through prompt_mode=none (idempotent, in-process only)."""
    global _BRIDGE_INSTALLED
    if _BRIDGE_INSTALLED:
        return
    from openjiuwen.core.single_agent.prompts.builder import SystemPromptBuilder as Base
    from openjiuwen.harness.prompts.builder import PromptMode, SystemPromptBuilder
    from openjiuwen.harness.prompts.sections import SectionName

    orig_build = SystemPromptBuilder.build
    orig_sections = SystemPromptBuilder._get_sections_for_build

    def _sections(self):  # type: ignore[no-untyped-def]
        if self.mode == PromptMode.NONE:
            return [
                s for s in Base._get_sections_for_build(self)
                if s.name == SectionName.IDENTITY or s.name in CAPABILITY_SECTIONS
            ]
        return orig_sections(self)

    def _build(self):  # type: ignore[no-untyped-def]
        if self.mode == PromptMode.NONE and any(n in CAPABILITY_SECTIONS for n in self._sections):
            return Base.build(self)
        return orig_build(self)

    SystemPromptBuilder._get_sections_for_build = _sections  # type: ignore[assignment]
    SystemPromptBuilder.build = _build  # type: ignore[assignment]
    _BRIDGE_INSTALLED = True


# ---------------------------------------------------------------------------
# Feature parsing
# ---------------------------------------------------------------------------

def _b(v: Any, default: bool = False) -> bool:
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        return bool(v)
    if isinstance(v, str):
        return v.strip().lower() in ("1", "true", "yes", "on")
    if isinstance(v, dict):
        return _b(v.get("enabled"), True)
    return default


def _d(v: Any) -> dict:
    return v if isinstance(v, dict) else ({"enabled": True} if v is True else {})


def parse_features(raw: Any) -> dict:
    """Normalize the wire ``features`` object. Unknown keys are ignored."""
    raw = raw if isinstance(raw, dict) else {}
    env_task_loop = os.environ.get("AGENTCORE_TASK_LOOP", "").strip() == "1"
    sk = _d(raw.get("skills"))
    pl = _d(raw.get("planning"))
    me = _d(raw.get("memory"))
    sa = _d(raw.get("subagents"))
    it = _d(raw.get("interrupts"))
    pt = _d(raw.get("progressive_tools"))
    so = _d(raw.get("sys_operation"))
    mc = _d(raw.get("mcp"))
    mo = _d(raw.get("moa"))
    rg = _d(raw.get("rag"))
    ot = _d(raw.get("otel"))
    f = {
        "skills": {
            "enabled": _b(raw.get("skills")),
            "mode": sk.get("mode") if sk.get("mode") in ("all", "auto_list") else "all",
            "items": [x for x in (sk.get("items") or []) if isinstance(x, dict) and x.get("name")],
            "host_loader": sk.get("host_loader") or None,
            "max_skills": sk.get("max_skills"),
            "max_total_chars": sk.get("max_total_chars"),
        },
        "planning": {
            "enabled": _b(raw.get("planning")),
            "mirror_tool": pl.get("mirror_tool") or None,
            "progress_reminder": _b(pl.get("progress_reminder")),
            "interval": int(pl.get("interval") or 20),
        },
        "memory": {
            "enabled": _b(raw.get("memory")),
            "scope": me.get("scope") if me.get("scope") in ("global", "project", "session") else "global",
            "proactive": _b(me.get("proactive"), True) if "proactive" in me else True,
            "coding": _b(me.get("coding")),
            "embedding": me.get("embedding") if isinstance(me.get("embedding"), dict) else None,
            "external": me.get("external") if isinstance(me.get("external"), dict) else None,
        },
        "subagents": {
            "enabled": _b(raw.get("subagents")) or env_task_loop,
            "async": _b(sa.get("async")),
            "task_loop": _b(sa.get("task_loop")) or env_task_loop,
            "agents": [a for a in (sa.get("agents") or []) if isinstance(a, dict) and a.get("name")],
            "max_iterations": sa.get("max_iterations"),
        },
        "interrupts": {
            "ask_user": _b(it.get("ask_user")),
            "confirm_tools": [str(x) for x in (it.get("confirm_tools") or [])],
        },
        "security": _b(raw.get("security")),
        "anomaly": _b(raw.get("anomaly")),
        "heartbeat": _b(raw.get("heartbeat")),
        "progressive_tools": {"enabled": _b(raw.get("progressive_tools")), "limit": int(pt.get("limit") or 5)},
        "sys_operation": {
            "enabled": _b(raw.get("sys_operation")),
            "read_only": _b(so.get("read_only")),
            "code": _b(so.get("code")),
        },
        "mcp": {
            "servers": [s for s in (mc.get("servers") or []) if isinstance(s, dict)],
            "resources": _b(mc.get("resources")),
        },
        "kv_cache": _b(raw.get("kv_cache")),
        "moa": {
            "enabled": _b(raw.get("moa")) and bool(mo.get("reference_models")),
            "reference_models": [m for m in (mo.get("reference_models") or []) if isinstance(m, dict)],
            "mode": mo.get("mode") or "aggregator_on_demand",
        },
        "rag": {
            "enabled": _b(raw.get("rag")) and bool(rg.get("paths")),
            "paths": [str(p) for p in (rg.get("paths") or [])],
            "max_files": int(rg.get("max_files") or 500),
            "max_bytes": int(rg.get("max_bytes") or 2_000_000),
        },
        "otel": {
            "enabled": _b(raw.get("otel")),
            "exporter": ot.get("exporter") or "file",
            "endpoint": ot.get("endpoint") or "",
            "traces_dir": ot.get("traces_dir") or "",
            "service_name": ot.get("service_name") or "dsh-jiuwen-agent-core",
        },
    }
    return f


def features_fingerprint(f: dict) -> str:
    """Hash of everything that requires rebuilding the agent (skill items excluded)."""
    slim = json.loads(json.dumps(f, default=str))
    slim.get("skills", {}).pop("items", None)
    return hashlib.sha256(json.dumps(slim, sort_keys=True).encode()).hexdigest()


def any_enabled(f: dict) -> bool:
    return any((
        f["skills"]["enabled"], f["planning"]["enabled"], f["memory"]["enabled"],
        f["memory"]["coding"], bool(f["memory"]["external"]), f["subagents"]["enabled"],
        f["interrupts"]["ask_user"], bool(f["interrupts"]["confirm_tools"]), f["security"],
        f["anomaly"], f["heartbeat"], f["progressive_tools"]["enabled"],
        f["sys_operation"]["enabled"], bool(f["mcp"]["servers"]), f["kv_cache"],
        f["moa"]["enabled"], f["rag"]["enabled"],
    ))


# ---------------------------------------------------------------------------
# Skills
# ---------------------------------------------------------------------------

_MARKER = ".dsh-host-skill"


def _slug(name: str) -> str:
    s = re.sub(r"[^A-Za-z0-9._-]+", "-", str(name)).strip("-.")
    return s[:80] or hashlib.sha1(str(name).encode()).hexdigest()[:12]


def _front_matter(name: str, description: str) -> str:
    desc = " ".join(str(description or "").split())[:1000]
    return f"---\nname: {json.dumps(str(name), ensure_ascii=False)}\ndescription: {json.dumps(desc, ensure_ascii=False)}\n---\n"


def _strip_front_matter(text: str) -> str:
    if text.startswith("---"):
        end = text.find("\n---", 3)
        if end != -1:
            return text[end + 4:].lstrip("\n")
    return text


def materialize_skills(skills_root: Path, items: List[dict]) -> List[str]:
    """Mirror host skills into ``skills_root/<slug>/SKILL.md``. Host is the source of truth:
    adapter-written copies not in ``items`` are removed; foreign dirs are left alone."""
    skills_root.mkdir(parents=True, exist_ok=True)
    wanted: Dict[str, dict] = {}
    for it in items:
        wanted[_slug(it["name"])] = it
    for child in skills_root.iterdir():
        if child.is_dir() and (child / _MARKER).exists() and child.name not in wanted:
            shutil.rmtree(child, ignore_errors=True)
    written = []
    for slug, it in wanted.items():
        d = skills_root / slug
        d.mkdir(parents=True, exist_ok=True)
        body = _strip_front_matter(str(it.get("content") or ""))
        desc = it.get("description") or next((ln.strip("# ").strip() for ln in body.splitlines() if ln.strip()), "")
        text = _front_matter(it["name"], desc) + body
        p = d / "SKILL.md"
        if not p.exists() or p.read_text(encoding="utf-8", errors="replace") != text:
            p.write_text(text, encoding="utf-8")
        (d / _MARKER).write_text(str(it["name"]), encoding="utf-8")
        written.append(it["name"])
    return written


def make_skill_rail(features: dict, skills_root: Path, sid: str, host_request: Optional[HostRequest]):
    from openjiuwen.core.runner import Runner
    from openjiuwen.harness.rails import SkillUseRail
    from openjiuwen.harness.tools import ToolOutput

    sk = features["skills"]
    loader = sk.get("host_loader")

    class DshSkillUseRail(SkillUseRail):
        """SkillUseRail over adapter-mirrored host skills. When the host has a skill
        loader tool, ``skill_tool`` proxies to it so dsh's own skill pipeline runs."""

        def init(self, agent):  # type: ignore[no-untyped-def]
            super().init(agent)
            if not loader or host_request is None:
                return
            card = self._owned_tool_cards.get("skill_tool")
            if card is None:
                return
            inst = Runner.resource_mgr.get_tool(tool_id=card.id)
            if inst is None:
                return

            async def _proxy(inputs: Dict[str, Any], **_kw: Any) -> Any:
                name = str((inputs or {}).get("skill_name") or "").strip()
                rel = str((inputs or {}).get("relative_file_path") or "SKILL.md").strip()
                if rel not in ("", "SKILL.md"):
                    # Host loader returns SKILL.md only; other files come from the mirror.
                    return await orig(inputs, **_kw)
                res = await host_request(sid, "tool", {"name": loader, "args": {"name": name}})
                ok = bool(res.get("ok", True)) if isinstance(res, dict) else True
                content = res.get("content") if isinstance(res, dict) else res
                if not ok:
                    return ToolOutput(success=False, error=str(content))
                text = content if isinstance(content, str) else json.dumps(content, ensure_ascii=False)
                return ToolOutput(success=True, data={"content": text, "skill_name": name, "via": loader})

            orig = inst.invoke
            inst.invoke = _proxy  # type: ignore[method-assign]

    kw: Dict[str, Any] = {}
    if sk.get("max_skills"):
        kw["max_skills"] = int(sk["max_skills"])
    if sk.get("max_total_chars"):
        kw["max_total_chars"] = int(sk["max_total_chars"])
    return DshSkillUseRail(
        skills_dir=[str(skills_root)],
        skill_mode=sk["mode"],
        include_tools=False,  # never register native read_file/bash: dsh owns file/shell tools
        **kw,
    )


# ---------------------------------------------------------------------------
# Task planning (todo) mirrored to dsh todo_write
# ---------------------------------------------------------------------------

def todos_to_dsh(todos: Iterable[Any]) -> List[dict]:
    """agent-core TodoItem list → dsh todo_write list (pending|in_progress|completed,
    unique content, at most one in_progress, cancelled dropped)."""
    out: List[dict] = []
    seen: Set[str] = set()
    active = False
    for t in todos or []:
        d = t.to_dict() if hasattr(t, "to_dict") else (t if isinstance(t, dict) else {})
        status = str(getattr(d.get("status"), "value", d.get("status") or "pending"))
        if status == "cancelled":
            continue
        content = " ".join(str(d.get("content") or d.get("description") or "").split())
        if not content or content in seen:
            continue
        seen.add(content)
        if status == "in_progress":
            if active:
                status = "pending"
            active = True
        if status not in ("pending", "in_progress", "completed"):
            status = "pending"
        out.append({"content": content, "status": status})
    return out


def make_planning_rail(features: dict, sid: str, host_request: Optional[HostRequest]):
    from openjiuwen.core.single_agent.rail.base import ToolCallInputs
    from openjiuwen.harness.rails import TaskPlanningRail

    pl = features["planning"]
    mirror = pl.get("mirror_tool")
    last: Dict[str, str] = {}

    class DshTaskPlanningRail(TaskPlanningRail):
        """TaskPlanningRail whose todo list is mirrored to dsh's todo_write (dsh UI + session)."""

        async def after_tool_call(self, ctx):  # type: ignore[no-untyped-def]
            await super().after_tool_call(ctx)
            if not mirror or host_request is None or not isinstance(ctx.inputs, ToolCallInputs):
                return
            name = ctx.inputs.tool_name or ""
            if not name.startswith("todo_") or name in ("todo_list", "todo_get") or ctx.session is None:
                return
            key = ctx.session.get_session_id()
            items = todos_to_dsh(self._todos_cache.get(key) or [])
            blob = json.dumps(items, ensure_ascii=False)
            if last.get(key, "[]") == blob:
                return  # unchanged (or a failed todo call): nothing to mirror
            last[key] = blob
            try:
                await host_request(sid, "tool", {"name": mirror, "args": {"todos": items}, "mirror": True})
            except Exception:
                logger.exception("todo mirror failed sid=%s", sid)

    return DshTaskPlanningRail(
        enable_progress_repeat=pl["progress_reminder"],
        list_tool_call_interval=pl["interval"],
    )


# ---------------------------------------------------------------------------
# Memory
# ---------------------------------------------------------------------------

def embedding_config(spec: Optional[dict], model_spec: dict):
    """EmbeddingConfig from features (key read from the named env var, never logged).
    Without a key the openjiuwen manager degrades to FTS5 keyword search."""
    from openjiuwen.core.foundation.store.base_embedding import EmbeddingConfig

    spec = spec or {}
    key_env = spec.get("api_key_env") or ""
    key = os.environ.get(key_env) if key_env else None
    base = spec.get("api_base") or ""
    name = spec.get("model") or ""
    if not (key and base and name):
        return EmbeddingConfig(model_name=name or "none", base_url=base or "http://127.0.0.1:9/v1", api_key=None), False
    return EmbeddingConfig(model_name=name, base_url=base, api_key=key), True


def scoped_sys_operation(root: Path, tag: str):
    """A LOCAL SysOperation sandboxed to ``root`` (no shell). Memory/RAG files live
    under the adapter data dir, outside the agent's own workspace sandbox."""
    from openjiuwen.core.runner import Runner
    from openjiuwen.core.sys_operation import LocalWorkConfig, OperationMode, SysOperationCard

    sid = "dsh_" + tag + "_" + hashlib.sha256(str(root).encode()).hexdigest()[:12]
    op = Runner.resource_mgr.get_sys_operation(sid)
    if op is None:
        Runner.resource_mgr.add_sys_operation(SysOperationCard(
            id=sid, mode=OperationMode.LOCAL,
            work_config=LocalWorkConfig(shell_allowlist=[], sandbox_root=[str(root)], restrict_to_sandbox=True),
        ))
        op = Runner.resource_mgr.get_sys_operation(sid)
    return op


def memory_root(data_dir: Path, scope: str, sid: str, cwd: Optional[str]) -> Path:
    if scope == "session":
        return data_dir / "memory" / "session" / _slug(sid)
    if scope == "project":
        h = hashlib.sha256(str(Path(cwd or ".").resolve()).encode()).hexdigest()[:16]
        return data_dir / "memory" / "project" / h
    return data_dir / "memory" / "global"


def make_memory_rails(features: dict, *, data_dir: Path, sid: str, cwd: Optional[str], model_spec: dict, language: str = "cn"):
    from openjiuwen.harness.rails import CodingMemoryRail, MemoryRail
    from openjiuwen.harness.workspace.workspace import Workspace

    me = features["memory"]
    rails: List[Any] = []
    emb, vector = embedding_config(me.get("embedding"), model_spec)
    info: Dict[str, Any] = {"vector": vector, "mode": "hybrid" if vector else "keyword"}
    if me["enabled"]:
        root = memory_root(data_dir, me["scope"], sid, cwd)
        root.mkdir(parents=True, exist_ok=True)
        ws = Workspace(root_path=str(root), language=language)
        op = scoped_sys_operation(root, "mem")

        class PinnedMemoryRail(MemoryRail):
            """MemoryRail on a shared, adapter-owned memory workspace (not the session workspace)."""

            def set_workspace(self, workspace):  # type: ignore[no-untyped-def]
                self.workspace = ws

            def set_sys_operation(self, sys_operation):  # type: ignore[no-untyped-def]
                self.sys_operation = op

        r = PinnedMemoryRail(embedding_config=emb, is_proactive=me["proactive"])
        r.workspace = ws
        r.sys_operation = op
        rails.append(r)
        info["root"] = str(root)
    if me["coding"]:
        h = hashlib.sha256(str(Path(cwd or ".").resolve()).encode()).hexdigest()[:16]
        cdir = data_dir / "coding_memory" / h
        cdir.mkdir(parents=True, exist_ok=True)
        cop = scoped_sys_operation(cdir, "cmem")

        class PinnedCodingMemoryRail(CodingMemoryRail):
            def set_sys_operation(self, sys_operation):  # type: ignore[no-untyped-def]
                self.sys_operation = cop

        cr = PinnedCodingMemoryRail(coding_memory_dir=str(cdir), embedding_config=emb, language=language)
        cr.sys_operation = cop
        rails.append(cr)
        info["coding_root"] = str(cdir)
    ext = me.get("external")
    if ext:
        prov = make_external_provider(ext)
        if prov is not None:
            from openjiuwen.harness.rails import ExternalMemoryRail
            rails.append(ExternalMemoryRail(prov, user_id=str(ext.get("user_id") or "dsh"), scope_id=str(ext.get("scope_id") or "__default__"), session_id=sid))
            info["external"] = ext.get("provider")
        else:
            info["external_error"] = f"unknown or unavailable provider: {ext.get('provider')}"
    return rails, info


EXTERNAL_PROVIDERS = {
    "mem0": ("openjiuwen.core.memory.external.mem0_provider", "Mem0MemoryProvider"),
    "openviking": ("openjiuwen.core.memory.external.openviking_memory_provider", "OpenVikingMemoryProvider"),
    "lakebase": ("openjiuwen.core.memory.external.lakebase_memory_provider", "LakeBaseMemoryProvider"),
    "agentarts": ("openjiuwen.core.memory.external.agentarts_memory_provider", "AgentArtsMemoryProvider"),
    "jiuwen": ("openjiuwen.core.memory.external.jiuwen_memory_provider", "JiuwenMemoryProvider"),
    "openjiuwen": ("openjiuwen.core.memory.external.openjiuwen_memory_provider", "OpenJiuwenMemoryProvider"),
}


def make_external_provider(ext: dict):
    import importlib

    name = str(ext.get("provider") or "").lower()
    if name not in EXTERNAL_PROVIDERS:
        return None
    mod, cls = EXTERNAL_PROVIDERS[name]
    try:
        klass = getattr(importlib.import_module(mod), cls)
    except Exception:
        logger.exception("external memory provider import failed: %s", name)
        return None
    opts = dict(ext.get("options") or {})
    for k in list(opts):
        if re.search(r"key|token|secret|password", k, re.I):
            opts.pop(k)  # secrets only via *_env
    key_env = ext.get("api_key_env")
    if key_env and os.environ.get(key_env):
        opts["api_key"] = os.environ[key_env]
    try:
        return klass(**opts)
    except Exception:
        logger.exception("external memory provider init failed: %s", name)
        return None


# ---------------------------------------------------------------------------
# dsh permission gate for native tools
# ---------------------------------------------------------------------------

def make_gate_rail(sid: str, host_tools: Any, host_request: Optional[HostRequest], extra_internal: Iterable[str] = ()):
    from openjiuwen.core.single_agent.rail.base import AgentCallbackEvent, ToolCallInputs
    from openjiuwen.harness.rails.security import BaseSecurityRail

    internal = set(INTERNAL_TOOLS) | set(extra_internal)
    # host_tools: a set, or a callable returning the *current* host tool names
    # (host tools can be re-bound between turns).
    current_host = host_tools if callable(host_tools) else (lambda: host_tools)

    class DshHostGateRail(BaseSecurityRail):
        """Asks dsh before any native (non-host) agent-core tool that is not purely internal.
        Fails closed: no host, error, timeout or anything but allow → the call is skipped."""

        priority = 99
        supported_events = {AgentCallbackEvent.BEFORE_TOOL_CALL}

        def __init__(self) -> None:
            super().__init__()
            self.asked: List[str] = []

        async def run_security_check(self, security_ctx):  # type: ignore[no-untyped-def]
            inputs = security_ctx.callback_ctx.inputs
            name = getattr(inputs, "tool_name", "") if isinstance(inputs, ToolCallInputs) else ""
            if not name or name in current_host() or name in internal:
                return self.allow()
            self.asked.append(name)
            if host_request is None:
                return self.reject(f"{name}: no dsh host to approve native agent-core tools")
            args = getattr(inputs, "tool_args", None)
            if isinstance(args, str):
                try:
                    args = json.loads(args)
                except Exception:
                    args = {"raw": args[:2000]}
            try:
                res = await host_request(sid, "permission", {"tool": name, "args": args if isinstance(args, dict) else {}})
            except Exception as exc:
                return self.reject(f"{name}: dsh permission check failed ({exc})")
            content = res.get("content") if isinstance(res, dict) else None
            allow = isinstance(content, dict) and content.get("allow") is True and res.get("ok", True)
            if allow:
                return self.allow()
            why = (content or {}).get("outcome") if isinstance(content, dict) else None
            return self.reject(f"{name} denied by dsh ({why or 'denied'})")

    return DshHostGateRail()


# ---------------------------------------------------------------------------
# RAG over configured document paths (openjiuwen lite index: FTS5 + optional vectors)
# ---------------------------------------------------------------------------

_RAG_EXT = {".md", ".markdown", ".txt", ".rst"}


def sync_rag_corpus(src_paths: List[str], dest: Path, max_files: int, max_bytes: int) -> dict:
    """Copy text docs into the RAG index dir (one-way, adapter-owned). Returns stats."""
    dest.mkdir(parents=True, exist_ok=True)
    seen: Set[str] = set()
    n = 0
    total = 0
    for raw in src_paths:
        root = Path(raw).expanduser()
        files = [root] if root.is_file() else (sorted(p for p in root.rglob("*") if p.is_file()) if root.is_dir() else [])
        for p in files:
            if p.suffix.lower() not in _RAG_EXT or n >= max_files:
                continue
            try:
                size = p.stat().st_size
            except OSError:
                continue
            if total + size > max_bytes:
                continue
            key = hashlib.sha1(str(p.resolve()).encode()).hexdigest()[:10]
            out = dest / f"{key}-{_slug(p.stem)}.md"
            text = p.read_text(encoding="utf-8", errors="replace")
            body = f"<!-- source: {p} -->\n{text}"
            if not out.exists() or out.read_text(encoding="utf-8", errors="replace") != body:
                out.write_text(body, encoding="utf-8")
            seen.add(out.name)
            n += 1
            total += size
    for old in dest.glob("*.md"):
        if old.name not in seen and old.name != "MEMORY.md":
            old.unlink(missing_ok=True)
    return {"files": n, "bytes": total}


def make_rag_tool(features: dict, *, data_dir: Path, model_spec: dict, sid: str, language: str = "cn"):
    from openjiuwen.core.foundation.tool import LocalFunction, ToolCard
    from openjiuwen.core.memory.lite.config import create_memory_settings
    from openjiuwen.core.memory.lite.manager import MemoryIndexManager, MemoryManagerParams
    from openjiuwen.harness.workspace.workspace import Workspace

    rg = features["rag"]
    h = hashlib.sha256(json.dumps(sorted(rg["paths"])).encode()).hexdigest()[:12]
    root = data_dir / "rag" / h
    ws = Workspace(root_path=str(root), language=language)
    mem_dir = Path(str(ws.get_node_path("memory") or (root / "memory")))
    # The lite indexer lists top-level *.md of the node dir only: flatten docs there.
    stats = sync_rag_corpus(rg["paths"], mem_dir, rg["max_files"], rg["max_bytes"])
    emb, vector = embedding_config(features["memory"].get("embedding"), model_spec)
    state: Dict[str, Any] = {"mgr": None}

    async def knowledge_search(query: str, limit: int = 5) -> Any:
        if state["mgr"] is None:
            settings = create_memory_settings(str(mem_dir), sources=["memory"])
            state["mgr"] = await MemoryIndexManager.get(MemoryManagerParams(
                agent_id=f"rag-{h}", workspace=ws, settings=settings, embedding_config=emb,
                sys_operation=scoped_sys_operation(root, "rag")))
            if state["mgr"] is not None:
                try:
                    await state["mgr"].sync(reason="rag", force=True)
                except TypeError:
                    await state["mgr"].sync(reason="rag")
        mgr = state["mgr"]
        if mgr is None:
            return {"results": [], "error": "knowledge index unavailable"}
        rows = await mgr.search(str(query), {"max_results": max(1, min(int(limit or 5), 20)), "min_score": 0.0})
        out = []
        for r in rows or []:
            d = r if isinstance(r, dict) else getattr(r, "__dict__", {})
            out.append({k: d.get(k) for k in ("path", "start_line", "end_line", "score", "snippet", "text") if d.get(k) is not None})
        return {"results": out, "mode": "hybrid" if vector else "keyword"}

    card = ToolCard(
        name="knowledge_search",
        description="Search the configured local knowledge base (project docs indexed by the adapter). Returns matching snippets with source paths.",
        input_params={"type": "object", "properties": {
            "query": {"type": "string", "description": "What to look for"},
            "limit": {"type": "integer", "description": "Max results (1-20)"},
        }, "required": ["query"]},
    )
    return LocalFunction(card=card, func=knowledge_search), {"root": str(root), **stats, "vector": vector}


# ---------------------------------------------------------------------------
# Assembly
# ---------------------------------------------------------------------------

@dataclass
class Assembled:
    rails: List[Any] = field(default_factory=list)
    kwargs: Dict[str, Any] = field(default_factory=dict)
    extra_tools: List[Any] = field(default_factory=list)
    info: Dict[str, Any] = field(default_factory=dict)
    gate: Any = None


def assemble(
    features: dict,
    *,
    sid: str,
    ws: Path,
    data_dir: Path,
    cwd: Optional[str],
    model: Any,
    model_spec: dict,
    host_tools: List[Any],
    host_request: Optional[HostRequest],
    build_model: Callable[[dict], Any],
    host_names_fn: Optional[Callable[[], Set[str]]] = None,
) -> Assembled:
    """Rails + create_deep_agent kwargs for the enabled capabilities."""
    from openjiuwen.core.single_agent.schema.agent_card import AgentCard
    from openjiuwen.harness.schema.config import SubAgentConfig

    out = Assembled()
    host_names = {t.card.name for t in host_tools}
    fixed: Set[str] = set()

    def names() -> Set[str]:
        return (host_names_fn() if host_names_fn else host_names) | fixed
    if not any_enabled(features):
        return out
    install_prompt_bridge()

    if features["skills"]["enabled"]:
        root = ws / "skills"
        skill_names = materialize_skills(root, features["skills"]["items"])
        out.rails.append(make_skill_rail(features, root, sid, host_request))
        out.info["skills"] = {"count": len(skill_names), "mode": features["skills"]["mode"], "loader": features["skills"]["host_loader"]}

    if features["planning"]["enabled"]:
        out.rails.append(make_planning_rail(features, sid, host_request))
        out.info["planning"] = {"mirror": features["planning"]["mirror_tool"]}

    me = features["memory"]
    if me["enabled"] or me["coding"] or me["external"]:
        rails, info = make_memory_rails(features, data_dir=data_dir, sid=sid, cwd=cwd, model_spec=model_spec)
        out.rails.extend(rails)
        out.info["memory"] = info

    if features["rag"]["enabled"]:
        tool, info = make_rag_tool(features, data_dir=data_dir, model_spec=model_spec, sid=sid)
        out.extra_tools.append(tool)
        out.info["rag"] = info

    if features["heartbeat"]:
        from openjiuwen.harness.rails import HeartbeatRail
        out.rails.append(HeartbeatRail())
        out.info["heartbeat"] = True

    it = features["interrupts"]
    if it["ask_user"]:
        from openjiuwen.harness.rails import AskUserRail
        out.rails.append(AskUserRail())
    if it["confirm_tools"]:
        from openjiuwen.harness.rails import ConfirmInterruptRail
        out.rails.append(ConfirmInterruptRail(tool_names=it["confirm_tools"]))
    if it["ask_user"] or it["confirm_tools"]:
        out.info["interrupts"] = {"ask_user": it["ask_user"], "confirm_tools": it["confirm_tools"]}

    so = features["sys_operation"]
    if so["enabled"]:
        from openjiuwen.harness.rails import SysOperationRail
        out.rails.append(SysOperationRail(with_code_tool=so["code"], read_only=so["read_only"]))
        out.kwargs["restrict_to_work_dir"] = True
        if cwd:
            out.kwargs["cwd"] = cwd
        out.info["sys_operation"] = {"read_only": so["read_only"], "gated": True}

    mc = features["mcp"]
    if mc["servers"]:
        from openjiuwen.core.foundation.tool import McpServerConfig
        cfgs = []
        for s in mc["servers"]:
            try:
                cfgs.append(McpServerConfig(**{k: v for k, v in s.items() if k in McpServerConfig.model_fields}))
            except Exception:
                logger.exception("bad mcp server config")
        if cfgs:
            out.kwargs["mcps"] = cfgs
        if mc["resources"]:
            from openjiuwen.harness.rails import McpRail
            out.rails.append(McpRail())
        out.info["mcp"] = {"servers": [c.server_name for c in cfgs], "gated": True}

    if features["security"]:
        out.kwargs["enable_security_rail"] = True
    if features["anomaly"]:
        out.kwargs["enable_model_anomaly_detection_rail"] = True
    if features["progressive_tools"]["enabled"]:
        out.kwargs["progressive_tool_enabled"] = True
        out.kwargs["tool_search_limit"] = max(1, min(20, features["progressive_tools"]["limit"]))
    if features["kv_cache"]:
        from openjiuwen.core.kv_cache.kv_cache_config import KVCacheAffinityConfig
        out.kwargs["kv_cache_affinity_config"] = KVCacheAffinityConfig(enable_kv_cache_affinity=True)
    mo = features["moa"]
    if mo["enabled"]:
        from openjiuwen.harness.moa.config import MoAConfig
        try:
            refs = tuple(build_model({**model_spec, **m}) for m in mo["reference_models"])
            out.kwargs["moa"] = MoAConfig(reference_models=refs, mode=mo["mode"])
            out.info["moa"] = {"refs": len(refs), "mode": mo["mode"]}
        except Exception as exc:  # bad mode / model spec: report, keep the agent usable
            out.info["moa"] = {"error": str(exc)[:200]}

    # dsh gate for native tools: always mounted when any capability is on.
    fixed.update(t.card.name for t in out.extra_tools)
    gate = make_gate_rail(sid, names, host_request)
    out.rails.append(gate)
    out.gate = gate

    sa = features["subagents"]
    if sa["enabled"]:
        tools = list(host_tools) + list(out.extra_tools)
        specs = []
        agents = sa["agents"] or [{"name": "general-purpose", "description": "General-purpose agent for multi-step subtasks. Uses the same dsh tools as the parent."}]
        for a in agents:
            specs.append(SubAgentConfig(
                agent_card=AgentCard(name=str(a["name"]), description=str(a.get("description") or a["name"])),
                system_prompt=str(a.get("system_prompt") or ""),
                tools=tools,
                model=model,
                rails=[make_gate_rail(sid, names, host_request)],
                workspace=None,
                max_iterations=a.get("max_iterations") or sa.get("max_iterations"),
            ))
        out.kwargs["subagents"] = specs
        out.kwargs["enable_async_subagent"] = sa["async"]
        out.kwargs["enable_task_loop"] = sa["task_loop"]
        out.info["subagents"] = {"agents": [s.agent_card.name for s in specs], "async": sa["async"], "task_loop": sa["task_loop"]}
    return out


_OTEL_ON = False


def ensure_otel(features: dict, data_dir: Path) -> Optional[dict]:
    """Process-wide OpenTelemetry tracing for agent-core (opt-in)."""
    global _OTEL_ON
    ot = features.get("otel") or {}
    if not ot.get("enabled") or _OTEL_ON:
        return {"enabled": _OTEL_ON} if ot.get("enabled") else None
    try:
        from openjiuwen.extensions.observability.config import ObservabilityConfig
        from openjiuwen.harness.observability.setup import acquire_observability

        kw: Dict[str, Any] = {"enabled": True, "exporter": ot["exporter"], "service_name": ot["service_name"]}
        if ot.get("endpoint"):
            kw["endpoint"] = ot["endpoint"]
        kw["traces_dir"] = ot.get("traces_dir") or str(data_dir / "traces")
        acquire_observability(ObservabilityConfig(**kw))
        _OTEL_ON = True
        return {"enabled": True, "exporter": kw["exporter"], "traces_dir": kw["traces_dir"]}
    except Exception as exc:
        logger.exception("otel init failed")
        return {"enabled": False, "error": str(exc)[:200]}
