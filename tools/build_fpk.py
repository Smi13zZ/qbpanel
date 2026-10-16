#!/usr/bin/env python3
"""Build qbpanel.fpk reproducibly.

Why this runs fnpack on the NAS instead of locally:
  * fnpack on Windows writes every member as 0666, so cmd/* and ui/index.cgi
    lose their executable bit.
  * Hand-repacking the .fpk afterwards to fix modes destroys whatever archive
    framing fnpack produced - fnOS then rejects the package with
    `Something wrong with appcenter: code 10111`.
  * The NAS already has the official Linux fnpack, so shipping the sources
    there, fixing modes and building in place is the reliable path.

Usage:  python tools/build_fpk.py [--host 192.168.1.13]
"""
import argparse
import os
import subprocess
import sys
import tarfile
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "qbpanel")
REMOTE_PY = os.path.abspath(
    os.path.join(ROOT, "..", ".workbuddy", "scripts", "remote.py")
)
VENV_PY = r"C:/Users/PVE/.workbuddy/binaries/python/envs/default/Scripts/python.exe"


def version_of():
    with open(os.path.join(SRC, "manifest"), encoding="utf-8") as f:
        for line in f:
            if line.strip().startswith("version"):
                return line.split("=", 1)[1].strip()
    return "0.0.0"


def appname_of():
    # fnpack names its output after the manifest appname (fn-qbpanel.fpk), so
    # the artefact name must follow it instead of being hardcoded.
    with open(os.path.join(SRC, "manifest"), encoding="utf-8") as f:
        for line in f:
            if line.strip().startswith("appname"):
                return line.split("=", 1)[1].strip()
    return "qbpanel"


def platform_of():
    # x86 / arm / all - drives the -fnos-<platform> suffix on the artefact name.
    with open(os.path.join(SRC, "manifest"), encoding="utf-8") as f:
        for line in f:
            if line.strip().startswith("platform"):
                return line.split("=", 1)[1].strip()
    return "x86"


SKIP_DIRS = {"__pycache__", ".pytest_cache", "node_modules", ".git", "_prev"}
SKIP_EXT = {".pyc", ".pyo", ".prev", ".log", ".orig", ".rej"}


def _skip(ti):
    """Keep build artefacts, bytecode caches and stray backups out of the fpk."""
    norm = ti.name.replace("\\", "/")
    if any(part in SKIP_DIRS for part in norm.split("/")):
        return None
    if norm.endswith(".DS_Store"):
        return None
    if os.path.splitext(norm)[1] in SKIP_EXT:
        return None
    return ti


def _run(argv):
    env = dict(os.environ, MSYS_NO_PATHCONV="1")
    out = subprocess.run(argv, capture_output=True, text=True, env=env)
    sys.stdout.write(out.stdout)
    if out.stderr:
        sys.stderr.write(out.stderr)
    return out


def remote(host, cmd, sudo=True):
    argv = [VENV_PY, REMOTE_PY]
    if host:
        argv += ["--host", host]
    if sudo:
        argv.append("--sudo")
    argv.append(cmd)
    out = _run(argv)
    if out.returncode != 0:
        raise SystemExit("remote command failed (exit %d)" % out.returncode)
    return out.stdout


def put(host, local, dest):
    argv = [VENV_PY, REMOTE_PY]
    if host:
        argv += ["--host", host]
    # remote.py wants native Windows paths, but backslashes confuse the
    # argument handling - forward slashes work everywhere.
    argv += ["--put", local.replace("\\", "/"), dest]
    out = _run(argv)
    if out.returncode != 0:
        raise SystemExit("upload failed (exit %d)" % out.returncode)


def get(host, src, local):
    argv = [VENV_PY, REMOTE_PY]
    if host:
        argv += ["--host", host]
    argv += ["--get", src, local.replace("\\", "/")]
    out = _run(argv)
    if out.returncode != 0:
        raise SystemExit("download failed (exit %d)" % out.returncode)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="192.168.1.13")
    ap.add_argument("--workdir", default="/tmp/qbpanel-build")
    args = ap.parse_args()

    # Guard: the local dev config holds credentials and must never be packed.
    leaked = os.path.join(SRC, "app", "var")
    if os.path.exists(leaked):
        raise SystemExit(
            "refusing to build: %s exists (local credentials would be packed). "
            "Use TRIM_PKGVAR outside the source tree for local runs." % leaked
        )

    ver = version_of()
    app = appname_of()
    plat = platform_of()
    tmp_tar = os.path.join(tempfile.gettempdir(), "qbpanel-src.tar")
    with tarfile.open(tmp_tar, "w") as tf:
        for name in sorted(os.listdir(SRC)):
            if name == "qbpanel.fpk":
                continue
            tf.add(os.path.join(SRC, name), arcname=name, filter=_skip)
    print("packed sources ->", tmp_tar)

    remote_tar = "/tmp/qbpanel-src.tar"
    put(args.host, tmp_tar, remote_tar)
    remote(
        args.host,
        "rm -rf {wd} && mkdir -p {wd} && tar -xf {tar} -C {wd} && cd {wd} && "
        "find . -type d -exec chmod 755 {{}} \\; && "
        "find . -type f -exec chmod 644 {{}} \\; && "
        "chmod 755 cmd/* app/ui/index.cgi && "
        "fnpack build && ls -la {app}.fpk".format(wd=args.workdir, tar=remote_tar, app=app),
    )

    out_name = "%s-%s-fnos-%s.fpk" % (app, ver, plat)
    out_path = os.path.join(ROOT, out_name)
    get(args.host, "%s/%s.fpk" % (args.workdir, app), out_path)
    print("built:", out_path, os.path.getsize(out_path), "bytes")

    # Remote paths must use forward slashes - os.path.join would emit a
    # backslash on Windows and the remote shell would see one long filename.
    keep = args.workdir.rstrip("/") + "/%s.fpk" % app
    remote(
        args.host,
        "cp -f {k} /vol1/1000/development/qbpanel/{app}-{v}.fpk && "
        "ls -la /vol1/1000/development/qbpanel/".format(k=keep, v=ver, app=app),
    )


if __name__ == "__main__":
    main()
