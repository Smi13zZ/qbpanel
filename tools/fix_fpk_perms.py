#!/usr/bin/env python3
"""fnpack on Windows writes every member as 0666 - no executable bit.
ui/index.cgi is executed directly by the fnOS CGI handler and cmd/* are run as
programs, so they need 0755. This rewrites the .fpk in place with correct modes
and refreshes manifest.checksum (which is the MD5 of app.tgz).
"""
import hashlib
import io
import os
import re
import sys
import tarfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FPK = os.path.join(ROOT, "qbpanel", "qbpanel.fpk")

EXEC_SUFFIX = (".cgi", ".sh")


def mode_for(name, is_dir):
    if is_dir:
        return 0o755
    base = os.path.basename(name)
    if name.startswith("cmd/") or base.endswith(EXEC_SUFFIX) or base in ("main",):
        return 0o755
    return 0o644


def repack_inner(data, inner_prefix_filter=None):
    """Rewrite an inner .tar.gz keeping member order but fixing modes."""
    out = io.BytesIO()
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as src:
        with tarfile.open(fileobj=out, mode="w:gz") as dst:
            for m in src.getmembers():
                payload = src.extractfile(m).read() if m.isfile() else None
                ti = tarfile.TarInfo(m.name)
                ti.mtime = m.mtime
                ti.uname = "root"
                ti.gname = "root"
                if m.isdir():
                    ti.type = tarfile.DIRTYPE
                    ti.mode = 0o755
                    dst.addfile(ti)
                else:
                    ti.type = tarfile.REGTYPE
                    ti.size = len(payload or b"")
                    ti.mode = mode_for(m.name, False)
                    dst.addfile(ti, io.BytesIO(payload or b""))
    return out.getvalue()


def main():
    if not os.path.isfile(FPK):
        print("missing", FPK)
        return 1

    with tarfile.open(FPK, "r") as tf:
        members = []
        for m in tf.getmembers():
            payload = tf.extractfile(m).read() if m.isfile() else None
            members.append((m.name, m.isdir(), m.mtime, payload))

    out_members = []
    new_apptgz = None
    manifest = None

    for name, is_dir, mtime, payload in members:
        if name == "app.tgz":
            new_apptgz = repack_inner(payload)
            out_members.append((name, False, mtime, new_apptgz))
        elif name == "manifest":
            manifest = payload.decode("utf-8")
            out_members.append((name, False, mtime, None))  # filled later
        else:
            out_members.append((name, is_dir, mtime, payload))

    digest = hashlib.md5(new_apptgz).hexdigest()
    manifest = re.sub(r"checksum\s*=\s*\S+", "checksum              = " + digest, manifest)
    print("new app.tgz md5:", digest)

    now = int(time.time())
    tmp = FPK + ".tmp"
    with tarfile.open(tmp, "w") as dst:
        for name, is_dir, mtime, payload in out_members:
            ti = tarfile.TarInfo(name)
            ti.mtime = mtime or now
            ti.uname = "root"
            ti.gname = "root"
            if is_dir:
                ti.type = tarfile.DIRTYPE
                ti.mode = 0o755
                dst.addfile(ti)
            else:
                data = manifest.encode("utf-8") if name == "manifest" else payload
                ti.type = tarfile.REGTYPE
                ti.size = len(data)
                ti.mode = mode_for(name, False)
                dst.addfile(ti, io.BytesIO(data))

    os.replace(tmp, FPK)
    print("rewrote", FPK, os.path.getsize(FPK), "bytes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
