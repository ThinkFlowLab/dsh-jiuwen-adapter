"""Shared fixtures for sidecar tests (offline, fake model)."""
from __future__ import annotations

import io
import json
import os
import sys
from pathlib import Path

import pytest

# Repo root on sys.path
ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

os.environ.setdefault("AGENTCORE_FAKE_MODEL", "1")
os.environ.setdefault("LLM_SSL_VERIFY", "false")
os.environ.setdefault("AGENTCORE_LOG_LEVEL", "WARNING")


@pytest.fixture
def ckpt_dir(tmp_path):
    d = tmp_path / "ac"
    d.mkdir()
    return d


@pytest.fixture
def fake():
    from sidecar import fake_model

    fake_model.install_fake_model()
    fake_model.reset_script()
    yield fake_model
    fake_model.reset_script()


class CaptureWriter(io.StringIO):
    def lines(self):
        self.seek(0)
        out = []
        for line in self.read().splitlines():
            line = line.strip()
            if line:
                out.append(json.loads(line))
        return out

    def clear(self):
        self.seek(0)
        self.truncate(0)


@pytest.fixture
def writer():
    return CaptureWriter()
