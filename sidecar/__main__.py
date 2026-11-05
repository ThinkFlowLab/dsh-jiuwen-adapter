"""python -m sidecar — start the stdio NDJSON-RPC server."""
from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path


def main() -> None:
    # Ensure repo root is importable when run as a script path.
    root = Path(__file__).resolve().parent.parent
    if str(root) not in sys.path:
        sys.path.insert(0, str(root))

    # openjiuwen (and friends) print INFO banners to stdout on import. stdout is
    # our NDJSON-RPC wire — stash the real pipe, point sys.stdout at stderr for
    # the rest of process life, and write RPC frames only to the stashed pipe.
    rpc_out = sys.stdout
    sys.stdout = sys.stderr

    from sidecar.server import configure_logging, run_stdio

    configure_logging()
    ckpt = os.environ.get("DSH_JIUVEN_AC_DIR") or os.environ.get("AGENTCORE_CKPT_DIR")
    checkpoint_dir = Path(ckpt).expanduser() if ckpt else None
    raise SystemExit(asyncio.run(run_stdio(checkpoint_dir=checkpoint_dir, writer_file=rpc_out)))


if __name__ == "__main__":
    main()
