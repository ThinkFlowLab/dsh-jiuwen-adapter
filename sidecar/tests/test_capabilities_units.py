"""Unit coverage for capabilities.assemble branches and the dsh gate (no model turns)."""
from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest
from openjiuwen.core.single_agent.rail.base import ToolCallInputs
from openjiuwen.harness.rails.security.base_security_rail import SecurityAllow

from sidecar import capabilities as caps

MODEL_SPEC = {"provider": "fake", "api_base": "http://127.0.0.1:9/v1", "api_key_env": "NO_KEY", "model": "fake-model"}


def sctx(name, args="{}"):
    return SimpleNamespace(callback_ctx=SimpleNamespace(inputs=ToolCallInputs(tool_name=name, tool_args=args)))


def host_tool(name):
    return SimpleNamespace(card=SimpleNamespace(name=name))


def build(features, tmp_path, host=("dsh_echo",), host_request=None, **kw):
    return caps.assemble(
        caps.parse_features(features), sid="u1", ws=tmp_path / "ws", data_dir=tmp_path / "data", cwd=str(tmp_path),
        model=None, model_spec=MODEL_SPEC, host_tools=[host_tool(n) for n in host], host_request=host_request,
        build_model=lambda spec: SimpleNamespace(spec=spec), **kw)


def test_b_coercion():
    assert caps._b("yes") and not caps._b("off") and caps._b(1) and not caps._b(0.0)
    assert caps._b({"enabled": False}) is False and caps._b({}) is True and caps._b(None, True)


def test_memory_scopes(tmp_path):
    assert caps.memory_root(tmp_path, "session", "a/b", None).parent.name == "session"
    p1 = caps.memory_root(tmp_path, "project", "s", str(tmp_path))
    assert p1.parent.name == "project" and p1 == caps.memory_root(tmp_path, "project", "t", str(tmp_path))
    assert caps.memory_root(tmp_path, "global", "s", None).name == "global"


async def test_gate_with_skills_does_not_gate_host_tools(tmp_path):
    """Regression: skill materialization must not shadow the host-name provider."""
    asked = []

    async def hr(sid, kind, payload, timeout=None):
        asked.append((kind, payload))
        return {"ok": True, "content": {"allow": False, "outcome": "denied"}}

    a = build({"skills": {"enabled": True, "items": [{"name": "s1", "content": "x"}]}, "sys_operation": True}, tmp_path, host_request=hr)
    assert isinstance(await a.gate.run_security_check(sctx("dsh_echo")), SecurityAllow)
    assert isinstance(await a.gate.run_security_check(sctx("skill_tool")), SecurityAllow)
    d = await a.gate.run_security_check(sctx("bash", "not json"))
    assert not isinstance(d, SecurityAllow)
    assert asked[0][1] == {"tool": "bash", "args": {"raw": "not json"}}
    assert a.info["sys_operation"]["gated"] and a.kwargs["restrict_to_work_dir"]


async def test_gate_fails_closed(tmp_path):
    g = caps.make_gate_rail("s", set(), None)
    assert not isinstance(await g.run_security_check(sctx("bash")), SecurityAllow)

    async def boom(*_a, **_k):
        raise RuntimeError("down")

    g = caps.make_gate_rail("s", lambda: {"h"}, boom)
    assert isinstance(await g.run_security_check(sctx("h")), SecurityAllow)
    assert not isinstance(await g.run_security_check(sctx("bash")), SecurityAllow)

    async def weird(*_a, **_k):
        return "yes"

    g = caps.make_gate_rail("s", set(), weird)
    assert not isinstance(await g.run_security_check(sctx("bash")), SecurityAllow)
    assert g.asked == ["bash"]


def test_assemble_flags_and_options(tmp_path):
    a = build({
        "mcp": {"servers": [{"server_id": "m1", "server_name": "m1", "server_path": "http://127.0.0.1:9/mcp", "client_type": "streamable-http"}, {"bogus": 1}], "resources": True},
        "security": True, "anomaly": True, "progressive_tools": {"enabled": True, "limit": 99}, "kv_cache": True,
        "moa": {"enabled": True, "reference_models": [{"model": "ref-a"}], "mode": "aggregator_on_demand"},
        "heartbeat": True, "interrupts": {"ask_user": True, "confirm_tools": ["bash"]},
    }, tmp_path)
    k = a.kwargs
    assert k["enable_security_rail"] and k["enable_model_anomaly_detection_rail"] and k["progressive_tool_enabled"]
    assert k["tool_search_limit"] == 20 and k["kv_cache_affinity_config"].enable_kv_cache_affinity
    assert a.info["moa"]["refs"] == 1 and a.info["mcp"]["servers"] == ["m1"] and a.info["heartbeat"]
    assert a.info["interrupts"]["confirm_tools"] == ["bash"]
    names = {type(r).__name__ for r in a.rails}
    assert {"McpRail", "HeartbeatRail", "AskUserRail", "ConfirmInterruptRail", "DshHostGateRail"} <= names


def test_memory_coding_and_external(tmp_path):
    a = build({"memory": {"enabled": True, "coding": True, "scope": "project", "external": {"provider": "nope"}}}, tmp_path)
    assert "coding_root" in a.info["memory"] and Path(a.info["memory"]["coding_root"]).is_dir()
    assert "external_error" in a.info["memory"]
    names = {type(r).__name__ for r in a.rails}
    assert {"PinnedMemoryRail", "PinnedCodingMemoryRail"} <= names
    cr = next(r for r in a.rails if type(r).__name__ == "PinnedCodingMemoryRail")
    keep = cr.sys_operation
    cr.set_sys_operation(object())
    assert cr.sys_operation is keep


def test_rag_corpus_limits(tmp_path):
    src = tmp_path / "src"
    src.mkdir()
    (src / "a.md").write_text("alpha")
    (src / "b.txt").write_text("b" * 500)
    (src / "c.bin").write_text("x")
    (src / "d.md").write_text("delta")
    st = caps.sync_rag_corpus([str(src), str(tmp_path / "missing")], tmp_path / "out", max_files=1, max_bytes=100)
    assert st["files"] == 1
    st = caps.sync_rag_corpus([str(src / "b.txt")], tmp_path / "out2", max_files=5, max_bytes=100)
    assert st["files"] == 0


def test_otel_file_exporter(tmp_path, monkeypatch):
    assert caps.ensure_otel(caps.parse_features({}), tmp_path) is None
    monkeypatch.setattr(caps, "_OTEL_ON", False)
    calls = []
    try:
        import openjiuwen.harness.observability.setup as setup
    except ImportError:  # optional exporter extra not installed → reported, not raised
        r = caps.ensure_otel(caps.parse_features({"otel": True}), tmp_path)
        assert r["enabled"] is False and r["error"]
        monkeypatch.setattr(caps, "_OTEL_ON", False)
        return
    monkeypatch.setattr(setup, "acquire_observability", lambda cfg: calls.append(cfg))
    r = caps.ensure_otel(caps.parse_features({"otel": {"enabled": True, "exporter": "file"}}), tmp_path)
    assert r["enabled"] and r["traces_dir"].endswith("traces") and calls
    assert caps.ensure_otel(caps.parse_features({"otel": True}), tmp_path) == {"enabled": True}
    monkeypatch.setattr(caps, "_OTEL_ON", False)
    monkeypatch.setattr(setup, "acquire_observability", lambda cfg: (_ for _ in ()).throw(RuntimeError("x")))
    assert caps.ensure_otel(caps.parse_features({"otel": True}), tmp_path)["enabled"] is False
    monkeypatch.setattr(caps, "_OTEL_ON", False)


def test_moa_bad_mode_is_reported(tmp_path):
    a = build({"moa": {"enabled": True, "reference_models": [{"model": "r"}], "mode": "verifier_routed"}}, tmp_path)
    assert "moa" not in a.kwargs and "error" in a.info["moa"]
