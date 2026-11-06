"""stdio NDJSON-RPC server for the agent-core sidecar."""
from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
from pathlib import Path
from typing import Any, Optional, TextIO

from . import fake_model
from .redact import redact_obj, redact_text
from .logutil import configure_logging
from .session_manager import SessionManager, default_checkpoint_dir

logger = logging.getLogger(__name__)

METHODS = {
    "turn.start",
    "turn.cancel",
    "tool.result",
    "session.fork",
    "session.delete",
    "session.history",
    "session.compact",
    "capabilities.status",
    "memory.op",
    "ping",
    "shutdown",
}




class NdjsonServer:
    def __init__(
        self,
        *,
        reader: Optional[asyncio.StreamReader] = None,
        writer_file: Optional[TextIO] = None,
        checkpoint_dir: Optional[Path] = None,
        session_manager: Optional[SessionManager] = None,
    ) -> None:
        self._reader = reader
        self._writer_file = writer_file or sys.stdout
        self._write_lock = asyncio.Lock()
        self._stopping = asyncio.Event()
        self._mgr = session_manager or SessionManager(
            emit=self._emit_event,
            checkpoint_dir=checkpoint_dir or default_checkpoint_dir(),
        )
        # If a custom manager was injected without emit wired, bind ours.
        if session_manager is not None and getattr(session_manager, "_emit", None) is None:
            session_manager._emit = self._emit_event
        self._pending_requests: dict[Any, asyncio.Task] = {}

    @property
    def manager(self) -> SessionManager:
        return self._mgr

    async def _emit_event(self, event: str, params: dict) -> None:
        await self._write({"event": event, "params": params})

    async def _write(self, obj: dict) -> None:
        # Never leak secrets onto the wire / stdout logs.
        safe = redact_obj(obj)
        line = json.dumps(safe, ensure_ascii=False, default=str)
        async with self._write_lock:
            self._writer_file.write(line + "\n")
            self._writer_file.flush()

    async def _reply_ok(self, req_id: Any, result: Any) -> None:
        await self._write({"id": req_id, "result": result})

    async def _reply_err(self, req_id: Any, message: str, code: int = -32000) -> None:
        await self._write(
            {"id": req_id, "error": {"code": code, "message": redact_text(message)}}
        )

    @staticmethod
    def _require(params: dict, *keys: str) -> None:
        missing = [k for k in keys if k not in params or params[k] in (None, "")]
        if missing:
            raise ValueError(f"missing params: {', '.join(missing)}")

    async def handle_request(self, msg: dict) -> None:
        req_id = msg.get("id")
        method = msg.get("method")
        params = msg.get("params", {})
        if params is None:
            params = {}
        if not isinstance(params, dict):
            if req_id is not None:
                await self._reply_err(req_id, "params must be an object", -32602)
            return
        if method not in METHODS:
            if req_id is not None:
                await self._reply_err(req_id, f"unknown method: {method}", -32601)
            return
        try:
            if method == "ping":
                await self._reply_ok(req_id, {"ok": True, "pong": True})
                return
            if method == "shutdown":
                await self._reply_ok(req_id, {"ok": True})
                self._stopping.set()
                return
            if method == "tool.result":
                self._require(params, "callId")
                await self._mgr.resolve_tool_result(
                    params["callId"],
                    bool(params.get("ok", True)),
                    params.get("content"),
                )
                if req_id is not None:
                    await self._reply_ok(req_id, {"ok": True})
                return
            if method == "turn.start":
                self._require(params, "sid", "query")
                result = await self._mgr.turn_start(params)
                await self._reply_ok(req_id, result)
                return
            if method == "turn.cancel":
                self._require(params, "sid")
                result = await self._mgr.turn_cancel(params)
                await self._reply_ok(req_id, result)
                return
            if method == "session.fork":
                self._require(params, "from", "to")
                result = await self._mgr.session_fork(params)
                await self._reply_ok(req_id, result)
                return
            if method == "session.delete":
                self._require(params, "sid")
                result = await self._mgr.session_delete(params)
                await self._reply_ok(req_id, result)
                return
            if method == "session.history":
                self._require(params, "sid")
                result = await self._mgr.session_history(params)
                await self._reply_ok(req_id, result)
                return
            if method == "capabilities.status":
                self._require(params, "sid")
                await self._reply_ok(req_id, self._mgr.capability_status(params["sid"]))
                return
            if method == "memory.op":
                result = await self._mgr.memory_op(params)
                await self._reply_ok(req_id, result)
                return
            if method == "session.compact":
                self._require(params, "sid")
                result = await self._mgr.session_compact(params)
                await self._reply_ok(req_id, result)
                return
        except asyncio.CancelledError:
            if req_id is not None:
                await self._reply_err(req_id, "cancelled", -32001)
            raise
        except ValueError as exc:
            if req_id is not None:
                await self._reply_err(req_id, str(exc), -32602)
        except Exception as exc:
            logger.exception("handler error method=%s", method)
            if req_id is not None:
                await self._reply_err(req_id, str(exc))

    async def _read_lines(self):
        if self._reader is not None:
            while not self._stopping.is_set():
                line = await self._reader.readline()
                if not line:
                    break
                yield line.decode("utf-8", errors="replace")
            return
        loop = asyncio.get_running_loop()
        queue: asyncio.Queue = asyncio.Queue()

        def _stdin_thread():
            try:
                for line in sys.stdin:
                    loop.call_soon_threadsafe(queue.put_nowait, line)
            finally:
                loop.call_soon_threadsafe(queue.put_nowait, None)

        import threading

        threading.Thread(target=_stdin_thread, daemon=True).start()
        while not self._stopping.is_set():
            line = await queue.get()
            if line is None:
                break
            yield line

    async def feed_line(self, line: str) -> None:
        """Test helper: push one NDJSON line through the request handler."""
        line = line.strip()
        if not line:
            return
        try:
            msg = json.loads(line)
        except json.JSONDecodeError as exc:
            logger.warning("invalid json: %s", exc)
            return
        if not isinstance(msg, dict):
            logger.warning("ignoring non-object json line")
            return
        await self.handle_request(msg)

    async def run(self) -> int:
        if fake_model.should_use_fake():
            fake_model.install_fake_model()
        await self._mgr.start()
        try:
            async for line in self._read_lines():
                line = line.strip()
                if not line:
                    continue
                try:
                    msg = json.loads(line)
                except json.JSONDecodeError as exc:
                    logger.warning("invalid json: %s", exc)
                    continue
                if not isinstance(msg, dict):
                    continue
                task = asyncio.create_task(self.handle_request(msg))
                req_id = msg.get("id")
                if req_id is not None:
                    self._pending_requests[req_id] = task

                def _done(t: asyncio.Task, rid=req_id):
                    if rid is not None:
                        self._pending_requests.pop(rid, None)
                    try:
                        t.result()
                    except asyncio.CancelledError:
                        pass
                    except Exception:
                        logger.exception("request task failed")

                task.add_done_callback(_done)
                if self._stopping.is_set():
                    break
            pending = [t for t in self._pending_requests.values() if not t.done()]
            if pending:
                await asyncio.gather(*pending, return_exceptions=True)
        finally:
            await self._mgr.stop()
        return 0


async def run_stdio(
    checkpoint_dir: Optional[Path] = None,
    writer_file: Optional[TextIO] = None,
) -> int:
    configure_logging()
    server = NdjsonServer(checkpoint_dir=checkpoint_dir, writer_file=writer_file)
    return await server.run()
