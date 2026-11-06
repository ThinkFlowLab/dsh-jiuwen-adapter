#!/usr/bin/env bash
# Private byte-for-byte config/runtime snapshot. Never prints file contents.
# Usage: scripts/jiuwen-snap.sh snap|restore|verify <private snapshot directory>
set -euo pipefail
umask 077
python3 - "$@" <<'PY'
import hashlib, json, os, pathlib, shutil, stat, sys
cmd, dest = sys.argv[1:]
home = pathlib.Path(os.environ.get('JIUWEN_HOME', str(pathlib.Path.home()/'.jiuwenswarm'))).resolve()
snap = pathlib.Path(dest).resolve()
if snap == home or home in snap.parents:
    raise SystemExit('snapshot must be outside Jiuwen home')
roots = ['config', 'runtime', 'agent/workspace/mcp/state.json']
def manifest(base):
    out = {}
    for root in roots:
        p = base/root
        items = [p, *sorted(p.rglob('*'))] if p.is_dir() and not p.is_symlink() else [p]
        for f in items:
            rel = str(f.relative_to(base))
            if not f.exists() and not f.is_symlink(): continue
            mode = stat.S_IMODE(f.lstat().st_mode)
            if f.is_symlink(): out[rel] = ['link', mode, os.readlink(f)]
            elif f.is_file(): out[rel] = ['file', mode, hashlib.sha256(f.read_bytes()).hexdigest()]
            elif f.is_dir(): out[rel] = ['dir', mode]
    return out
if cmd == 'snap':
    snap.mkdir(mode=0o700, parents=True, exist_ok=False)
    (snap/'files').mkdir(mode=0o700)
    for root in roots:
        src, dst = home/root, snap/'files'/root
        if src.is_dir(): shutil.copytree(src, dst, symlinks=True)
        elif src.exists() or src.is_symlink():
            dst.parent.mkdir(parents=True, exist_ok=True); shutil.copy2(src, dst, follow_symlinks=False)
    m = manifest(snap/'files')
    (snap/'manifest.json').write_text(json.dumps(m, sort_keys=True))
    if manifest(home) != m: raise SystemExit('snapshot changed while copying; stop writers and retry')
    print('snapshot OK:', sum(v[0]=='file' for v in m.values()), 'files')
elif cmd in ('restore', 'verify'):
    expected = json.loads((snap/'manifest.json').read_text())
    if manifest(snap/'files') != expected: raise SystemExit('snapshot checksum mismatch')
    if cmd == 'restore':
        for root in roots:
            src, dst = snap/'files'/root, home/root
            if dst.is_dir() and not dst.is_symlink(): shutil.rmtree(dst)
            elif dst.exists() or dst.is_symlink(): dst.unlink()
            if src.is_dir(): shutil.copytree(src, dst, symlinks=True)
            elif src.exists() or src.is_symlink():
                dst.parent.mkdir(parents=True, exist_ok=True); shutil.copy2(src, dst, follow_symlinks=False)
    if manifest(home) != expected: raise SystemExit('Jiuwen checksum/file-set/mode verification FAILED')
    print(cmd, 'OK: checksums, file set and modes identical')
else: raise SystemExit('usage: jiuwen-snap.sh snap|restore|verify <directory>')
PY
