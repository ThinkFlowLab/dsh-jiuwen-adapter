"""agent-core capabilities wired into the adapter (skills, planning, memory, gate, subagents, …)."""
from __future__ import annotations

import json
import os
from pathlib import Path

import pytest
from openjiuwen.core.foundation.llm import AssistantMessage, ToolCall

from sidecar import capabilities as caps
from sidecar.tests.harness import RpcHarness

FAKE_MODEL = {"provider": "fake", "api_base": "http://127.0.0.1:9/v1", "api_key_env": "NO_KEY", "model": "fake-model"}
ECHO = {"name": "dsh_echo", "description": "Echo via dsh", "parameters": {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]}}
SKILL = {"name": "skill", "description": "Load a skill", "parameters": {"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"]}}


def tc(name, args, i="c1"):
    return ToolCall(id=i, type="function", name=name, arguments=json.dumps(args))


def system_text(seen):
    return "\n".join(str(c) for r, c in seen["messages"] if r == "system")


def tool_msgs(seen):
    return [str(c) for r, c in seen["messages"] if r == "tool"]


async def turn(h, sid, features=None, tools=None, query="go", **extra):
    p = {"sid": sid, "query": query, "system": "HOST SYSTEM", "tools": tools if tools is not None else [ECHO], "model": FAKE_MODEL}
    if features is not None:
        p["features"] = features
    p.update(extra)
    r = await h.call("turn.start", p)
    assert r and "result" in r, r
    return r


@pytest.mark.asyncio
async def test_default_unchanged_and_workspace_outside_cwd(ckpt_dir, writer, fake, tmp_path):
    proj = tmp_path / "proj"
    proj.mkdir()
    fake.reset_script([AssistantMessage(content="hi")])
    h = RpcHarness(ckpt_dir, writer)
    await h.start()
    try:
        await turn(h, "d1", cwd=str(proj))
        seen = fake.SEEN[0]
        assert system_text(seen) == "HOST SYSTEM"
        assert seen["tools"] == ["dsh_echo"]
        assert list(proj.iterdir()) == [], "agent-core must not write into the project dir"
        assert (ckpt_dir / "ws" / "d1").is_dir()
    finally:
        await h.stop()


@pytest.mark.asyncio
async def test_skills_native_prompt_and_host_loader_proxy(ckpt_dir, writer, fake):
    fake.reset_script([AssistantMessage(content="", tool_calls=[tc("skill_tool", {"skill_name": "pdf-tools"})]), AssistantMessage(content="ok")])
    loads = []

    def tool_handler(p):
        loads.append(p)
        return {"ok": True, "content": "# PDF tools\nFULL BODY FROM DSH"}

    h = RpcHarness(ckpt_dir, writer, tool_handler=tool_handler)
    await h.start()
    try:
        feats = {"skills": {"enabled": True, "items": [{"name": "pdf-tools", "description": "Work with PDF files", "content": "# PDF tools\nbody"}], "host_loader": "skill"}}
        await turn(h, "s1", feats, tools=[ECHO])
        seen = fake.SEEN[0]
        sysmsg = system_text(seen)
        assert sysmsg.startswith("HOST SYSTEM")
        assert "pdf-tools" in sysmsg and "Work with PDF files" in sysmsg
        assert "skill_tool" in seen["tools"]
        assert "read_file" not in seen["tools"] and "bash" not in seen["tools"]
        assert loads and loads[0]["name"] == "skill" and loads[0]["args"] == {"name": "pdf-tools"}
        assert any("FULL BODY FROM DSH" in m for m in tool_msgs(fake.SEEN[1]))
        md = ckpt_dir / "ws" / "s1" / "skills" / "pdf-tools" / "SKILL.md"
        assert md.is_file()
        # host removed the skill → mirror removes it
        fake.reset_script([AssistantMessage(content="ok")])
        await turn(h, "s1", {"skills": {"enabled": True, "items": [], "host_loader": "skill"}})
        assert not md.exists()
    finally:
        await h.stop()


@pytest.mark.asyncio
async def test_skills_without_loader_reads_mirror(ckpt_dir, writer, fake):
    fake.reset_script([AssistantMessage(content="", tool_calls=[tc("skill_tool", {"skill_name": "demo"})]), AssistantMessage(content="ok")])
    h = RpcHarness(ckpt_dir, writer)
    await h.start()
    try:
        await turn(h, "s2", {"skills": {"enabled": True, "items": [{"name": "demo", "content": "---\nname: demo\ndescription: d\n---\nMIRROR BODY"}]}})
        assert not h.tool_calls()
        assert any("MIRROR BODY" in m for m in tool_msgs(fake.SEEN[1]))
    finally:
        await h.stop()


@pytest.mark.asyncio
async def test_planning_mirrors_todo_write(ckpt_dir, writer, fake):
    todos = [{"id": "a", "content": "Step A", "activeForm": "Doing A", "description": "do A", "status": "in_progress"}, {"id": "b", "content": "Step B", "activeForm": "Doing B", "description": "do B", "status": "pending"}]
    fake.reset_script([AssistantMessage(content="", tool_calls=[tc("todo_create", {"todos": todos})]), AssistantMessage(content="planned")])
    h = RpcHarness(ckpt_dir, writer, tool_handler=lambda p: {"ok": True, "content": {"ok": True}})
    await h.start()
    try:
        await turn(h, "p1", {"planning": {"enabled": True, "mirror_tool": "todo_write"}})
        seen = fake.SEEN[0]
        assert {"todo_create", "todo_list", "todo_modify", "todo_get"} <= set(seen["tools"])
        assert "todo_write" not in seen["tools"]
        mirror = [c for c in h.tool_calls() if c["name"] == "todo_write"]
        assert mirror, h.tool_calls()
        assert mirror[0]["mirror"] is True
        got = mirror[0]["args"]["todos"]
        assert [t["content"] for t in got] == ["Step A", "Step B"], got
        assert got[0]["status"] == "in_progress"
    finally:
        await h.stop()


def test_todos_to_dsh_normalizes():
    out = caps.todos_to_dsh([
        {"content": "a", "status": "in_progress"}, {"content": "b", "status": "in_progress"},
        {"content": "a", "status": "pending"}, {"content": "c", "status": "cancelled"}, {"content": " ", "status": "pending"},
        {"content": "d", "status": "weird"},
    ])
    assert out == [{"content": "a", "status": "in_progress"}, {"content": "b", "status": "pending"}, {"content": "d", "status": "pending"}]


@pytest.mark.asyncio
async def test_memory_tools_persist_under_data_dir_and_ops(ckpt_dir, writer, fake, monkeypatch):
    monkeypatch.delenv("MEMORY_ENABLED", raising=False)
    fake.reset_script([
        AssistantMessage(content="", tool_calls=[tc("write_memory", {"path": "MEMORY.md", "content": "User prefers tabs over spaces", "append": True})]),
        AssistantMessage(content="saved"),
    ])
    h = RpcHarness(ckpt_dir, writer)
    await h.start()
    try:
        await turn(h, "m1", {"memory": {"enabled": True}})
        seen = fake.SEEN[0]
        assert {"memory_search", "write_memory", "read_memory"} <= set(seen["tools"])
        mdir = ckpt_dir / "memory" / "global" / "memory"
        r = await h.call("memory.op", {"op": "list"})
        files = [f["path"] for f in r["result"]["files"]]
        assert "MEMORY.md" in files, (r, list(mdir.rglob("*")))
        r = await h.call("memory.op", {"op": "search", "query": "tabs"})
        assert r["result"]["hits"], r
        r = await h.call("memory.op", {"op": "show", "path": "MEMORY.md"})
        assert "tabs" in r["result"]["content"]
        r = await h.call("memory.op", {"op": "show", "path": "../../etc/passwd"})
        assert r["result"]["ok"] is False
        assert (await h.call("memory.op", {"op": "clear"}))["result"]["ok"] is False
        r = await h.call("memory.op", {"op": "clear", "confirm": True})
        assert r["result"]["removed"] >= 1
        st = await h.call("capabilities.status", {"sid": "m1"})
        assert st["result"]["info"]["memory"]["mode"] == "keyword"
    finally:
        await h.stop()


def test_embedding_config_key_from_env_only(monkeypatch):
    monkeypatch.setenv("EMB_KEY_T", "k-123")
    cfg, vec = caps.embedding_config({"model": "e", "api_base": "http://x/v1", "api_key_env": "EMB_KEY_T"}, {})
    assert vec is True and cfg.api_key == "k-123"
    cfg, vec = caps.embedding_config({"model": "e", "api_base": "http://x/v1", "api_key_env": "MISSING_T"}, {})
    assert vec is False and cfg.api_key is None


@pytest.mark.asyncio
async def test_sys_operation_tools_gated_by_dsh(ckpt_dir, writer, fake, tmp_path):
    proj = tmp_path / "p"
    proj.mkdir()
    secret = proj / "f.txt"
    secret.write_text("TOPSECRET")
    fake.reset_script([AssistantMessage(content="", tool_calls=[tc("read_file", {"file_path": str(secret)})]), AssistantMessage(content="done")])
    h = RpcHarness(ckpt_dir, writer, host_handler=lambda p: {"ok": True, "content": {"allow": False, "outcome": "rejected"}})
    await h.start()
    try:
        await turn(h, "g1", {"sys_operation": {"enabled": True, "read_only": True}}, cwd=str(proj))
        reqs = h.host_requests()
        assert reqs and reqs[0]["kind"] == "permission" and reqs[0]["tool"] == "read_file"
        assert not any("TOPSECRET" in m for m in tool_msgs(fake.SEEN[1]))
        assert any("denied by dsh" in m for m in tool_msgs(fake.SEEN[1]))
    finally:
        await h.stop()


@pytest.mark.asyncio
async def test_gate_allows_and_never_gates_host_tools(ckpt_dir, writer, fake, tmp_path):
    f = tmp_path / "ok.txt"
    f.write_text("VISIBLE")
    fake.reset_script([
        AssistantMessage(content="", tool_calls=[tc("dsh_echo", {"text": "x"}, "h1")]),
        AssistantMessage(content="", tool_calls=[tc("read_file", {"file_path": str(f)}, "h2")]),
        AssistantMessage(content="done"),
    ])
    h = RpcHarness(ckpt_dir, writer, host_handler=lambda p: {"ok": True, "content": {"allow": True, "outcome": "allowed-once"}})
    await h.start()
    try:
        await turn(h, "g2", {"sys_operation": {"enabled": True, "read_only": True}}, cwd=str(tmp_path))
        assert [r["tool"] for r in h.host_requests()] == ["read_file"]
        assert [c["name"] for c in h.tool_calls()] == ["dsh_echo"]
        assert any("VISIBLE" in m for m in tool_msgs(fake.SEEN[2]))
    finally:
        await h.stop()


@pytest.mark.asyncio
async def test_subagent_tools_route_through_dsh(ckpt_dir, writer, fake):
    fake.reset_script([
        AssistantMessage(content="", tool_calls=[tc("task_tool", {"subagent_type": "general-purpose", "task_description": "echo child"}, "t1")]),
        AssistantMessage(content="", tool_calls=[tc("dsh_echo", {"text": "child"}, "c1")]),
        AssistantMessage(content="child done"),
        AssistantMessage(content="parent done"),
    ])
    h = RpcHarness(ckpt_dir, writer)
    await h.start()
    try:
        await turn(h, "sa1", {"subagents": {"enabled": True}})
        assert "task_tool" in fake.SEEN[0]["tools"]
        child_tools = set(fake.SEEN[1]["tools"])
        assert "dsh_echo" in child_tools
        assert not ({"read_file", "write_file", "bash", "edit_file"} & child_tools)
        calls = h.tool_calls()
        assert [c["name"] for c in calls] == ["dsh_echo"] and calls[0]["sid"] == "sa1"
    finally:
        await h.stop()


@pytest.mark.asyncio
async def test_confirm_interrupt_resumes_via_dsh(ckpt_dir, writer, fake):
    fake.reset_script([AssistantMessage(content="", tool_calls=[tc("dsh_echo", {"text": "x"})]), AssistantMessage(content="after")])
    asked = []

    def host(p):
        asked.append(p)
        return {"ok": True, "content": {"answer": {"approved": True, "feedback": ""}}}

    h = RpcHarness(ckpt_dir, writer, host_handler=host)
    await h.start()
    try:
        await turn(h, "i1", {"interrupts": {"confirm_tools": ["dsh_echo"]}})
        assert asked and asked[0]["kind"] == "interaction"
        assert [c["name"] for c in h.tool_calls()] == ["dsh_echo"]
        assert any(c["type"] == "answer" for c in h.chunks("i1"))
    finally:
        await h.stop()


@pytest.mark.asyncio
async def test_confirm_interrupt_denied_skips_tool(ckpt_dir, writer, fake):
    fake.reset_script([AssistantMessage(content="", tool_calls=[tc("dsh_echo", {"text": "x"})]), AssistantMessage(content="after")])
    h = RpcHarness(ckpt_dir, writer, host_handler=lambda p: {"ok": True, "content": {"answer": {"approved": False, "feedback": "no"}}})
    await h.start()
    try:
        await turn(h, "i2", {"interrupts": {"confirm_tools": ["dsh_echo"]}})
        assert not h.tool_calls()
    finally:
        await h.stop()


@pytest.mark.asyncio
async def test_flags_build_and_features_change_rebuilds(ckpt_dir, writer, fake):
    fake.reset_script([AssistantMessage(content="a"), AssistantMessage(content="b"), AssistantMessage(content="c")])
    h = RpcHarness(ckpt_dir, writer)
    await h.start()
    try:
        await turn(h, "f1", {"security": True, "anomaly": True, "kv_cache": True, "heartbeat": True, "progressive_tools": {"enabled": True, "limit": 3}})
        st = (await h.call("capabilities.status", {"sid": "f1"}))["result"]
        assert st["info"].get("heartbeat") is True
        await turn(h, "f1", {"security": True, "anomaly": True, "kv_cache": True, "heartbeat": True, "progressive_tools": {"enabled": True, "limit": 3}}, runKind="heartbeat")
        await turn(h, "f1", None)
        phases = [c["payload"] for c in h.chunks("f1") if c["type"] == "adapter_phase"]
        assert phases[-1].get("rebuilt_for_features") is True
        assert system_text(fake.SEEN[-1]) == "HOST SYSTEM"
    finally:
        await h.stop()


@pytest.mark.asyncio
async def test_rag_knowledge_search(ckpt_dir, writer, fake, tmp_path):
    docs = tmp_path / "docs"
    (docs / "sub").mkdir(parents=True)
    (docs / "sub" / "deploy.md").write_text("# Deploy\nUse the blue-green rollout with canary percentage 5.\n")
    (docs / "skip.bin").write_bytes(b"\x00\x01")
    fake.reset_script([AssistantMessage(content="", tool_calls=[tc("knowledge_search", {"query": "canary"})]), AssistantMessage(content="ok")])
    h = RpcHarness(ckpt_dir, writer)
    await h.start()
    try:
        await turn(h, "r1", {"rag": {"enabled": True, "paths": [str(docs)]}})
        assert "knowledge_search" in fake.SEEN[0]["tools"]
        assert not h.host_requests(), "knowledge_search reads the adapter index only"
        msgs = tool_msgs(fake.SEEN[1])
        assert any("canary" in m for m in msgs), msgs
    finally:
        await h.stop()


def test_parse_features_defaults_and_env(monkeypatch):
    f = caps.parse_features(None)
    assert not caps.any_enabled(f)
    monkeypatch.setenv("AGENTCORE_TASK_LOOP", "1")
    f = caps.parse_features({})
    assert f["subagents"]["enabled"] and f["subagents"]["task_loop"]
    monkeypatch.delenv("AGENTCORE_TASK_LOOP")
    f = caps.parse_features({"skills": True, "memory": {"scope": "bogus"}, "rag": {"enabled": True}})
    assert f["skills"]["enabled"] and f["skills"]["mode"] == "all"
    assert f["memory"]["scope"] == "global" and not f["rag"]["enabled"]
    a = caps.features_fingerprint(caps.parse_features({"skills": {"enabled": True, "items": [{"name": "x"}]}}))
    b = caps.features_fingerprint(caps.parse_features({"skills": {"enabled": True, "items": [{"name": "y"}]}}))
    assert a == b


def test_external_provider_factory_strips_inline_secrets(monkeypatch):
    assert caps.make_external_provider({"provider": "nope"}) is None
    monkeypatch.setenv("M0_KEY_T", "zzz")
    p = caps.make_external_provider({"provider": "mem0", "options": {"user_id": "u", "api_key": "inline"}, "api_key_env": "M0_KEY_T"})
    assert p is not None and getattr(p, "_api_key", None) == "zzz"


def test_materialize_skills_leaves_foreign_dirs(tmp_path):
    root = tmp_path / "skills"
    (root / "mine").mkdir(parents=True)
    (root / "mine" / "SKILL.md").write_text("x")
    caps.materialize_skills(root, [{"name": "a b/c", "content": "body"}])
    assert (root / "mine").is_dir()
    slug = caps._slug("a b/c")
    assert (root / slug / "SKILL.md").read_text().startswith("---\nname: \"a b/c\"")
    caps.materialize_skills(root, [])
    assert not (root / slug).exists() and (root / "mine").exists()
