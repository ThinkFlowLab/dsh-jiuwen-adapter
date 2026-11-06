"""In-process NDJSON RPC test harness with auto tool.result replies."""
from __future__ import annotations

import asyncio
import json
from typing import Any, Callable, Dict, List, Optional

from sidecar.server import NdjsonServer, configure_logging
from sidecar.session_manager import SessionManager


class RpcHarness:
    def __init__(
        self,
        ckpt_dir,
        writer,
        *,
        tool_handler: Optional[Callable[[dict], Any]] = None,
        tool_delay: float = 0.0,
        host_handler: Optional[Callable[[dict], Any]] = None,
    ):
        configure_logging("WARNING")
        self.writer = writer
        self.events: List[dict] = []
        self.responses: Dict[Any, dict] = {}
        self._tool_handler = tool_handler or (lambda p: {"ok": True, "content": {"echo": p.get("args", {})}})
        self._tool_delay = tool_delay
        self._host_handler = host_handler or (lambda p: {"ok": True, "content": {"allow": False, "outcome": "test-default-deny"}})
        self._req_n = 0
        self._server = NdjsonServer(writer_file=writer, checkpoint_dir=ckpt_dir)
        # Rebind emit so we can intercept tool.call before writing.
        self._server._mgr._emit = self._emit
        self.mgr: SessionManager = self._server._mgr

    async def start(self):
        await self.mgr.start()

    async def stop(self):
        await self.mgr.stop()

    async def _emit(self, event: str, params: dict) -> None:
        self.events.append({"event": event, "params": params})
        await self._server._write({"event": event, "params": params})
        if event == "host.request":
            reply = self._host_handler(params)
            if reply is None:
                return
            await self.mgr.resolve_tool_result(params["callId"], bool(reply.get("ok", True)), reply.get("content"))
            return
        if event == "tool.call":
            if self._tool_delay:
                await asyncio.sleep(self._tool_delay)
            reply = self._tool_handler(params)
            if reply is None:
                return  # leave pending (for timeout / cancel tests)
            await self.mgr.resolve_tool_result(
                params["callId"],
                bool(reply.get("ok", True)),
                reply.get("content"),
            )

    def _next_id(self):
        self._req_n += 1
        return f"r{self._req_n}"

    async def call(self, method: str, params: Optional[dict] = None, *, req_id=None):
        rid = self._next_id() if req_id is None else req_id
        before = len(self.writer.lines())
        msg = {"id": rid, "method": method, "params": params or {}}
        task = asyncio.create_task(self._server.handle_request(msg))
        try:
            await task
        except asyncio.CancelledError:
            pass
        # Collect response with matching id
        for line in self.writer.lines()[before:]:
            if line.get("id") == rid:
                self.responses[rid] = line
                return line
        return None

    async def call_nowait(self, method: str, params: Optional[dict] = None, *, req_id=None):
        rid = self._next_id() if req_id is None else req_id
        msg = {"id": rid, "method": method, "params": params or {}}
        task = asyncio.create_task(self._server.handle_request(msg))
        return rid, task

    def chunks(self, sid: Optional[str] = None) -> List[dict]:
        out = []
        for e in self.events:
            if e.get("event") != "chunk":
                continue
            if sid is not None and e["params"].get("sid") != sid:
                continue
            out.append(e["params"])
        return out

    def host_requests(self) -> List[dict]:
        return [e["params"] for e in self.events if e.get("event") == "host.request"]

    def tool_calls(self) -> List[dict]:
        return [e["params"] for e in self.events if e.get("event") == "tool.call"]
