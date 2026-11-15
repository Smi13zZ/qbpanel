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

Transport is plain `ssh` / `scp` against the host alias from ~/.ssh/config.
The remote script goes in over stdin, not as an argv element: the permission
fix uses `find ... -exec chmod 755 {} \\;`, and that brace/semicolon pair gets
mangled by shell quoting long before it reaches the device.

Usage:
    python tools/build_fpk.py                        # build + push to the device
    python tools/build_fpk.py --no-push              # build only
    python tools/build_fpk.py --host fnos-test       # pick another alias
"""
import argparse
import os
import subprocess
import sys
import tarfile
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "qbpanel")
DEFAULT_HOST = "fnos-test"
DEFAULT_DEPLOY_DIR = "/vol1/1000/development/qbpanel"
REMOTE_TAR = "/tmp/qbpanel-src.tar"

# BatchMode keeps a missing key an error instead of a password prompt.
SSH_OPTS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10"]


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


def _run(argv, stdin=None):
    """Run a command, feeding stdin as raw bytes.

    Text mode would rewrite "\\n" to "\\r\\n" on the way into the child, and a
    CRLF shell script on the device dies on `set: -: invalid option` and
    `unknown command "build\\r"`. Bytes keep the line endings we wrote.
    """
    payload = None if stdin is None else stdin.encode("utf-8")
    out = subprocess.run(argv, input=payload, capture_output=True)
    # Device consoles are GBK; decoding must never raise or the real failure
    # message gets swallowed by the reader.
    text = (out.stdout or b"").decode("utf-8", "replace")
    err = (out.stderr or b"").decode("utf-8", "replace")
    sys.stdout.write(text)
    if err:
        sys.stderr.write(err)
    out.stdout, out.stderr = text, err
    return out


def remote(host, script):
    """Run a bash script on <host>. The body arrives on stdin, unquoted."""
    out = _run(["ssh"] + SSH_OPTS + [host, "bash -s"], stdin=script)
    if out.returncode != 0:
        raise SystemExit("remote command failed (exit %d)" % out.returncode)
    return out.stdout


def put(host, local, dest):
    out = _run(["scp", "-q"] + SSH_OPTS + [local, "%s:%s" % (host, dest)])
    if out.returncode != 0:
        raise SystemExit("upload failed (exit %d)" % out.returncode)


def get(host, src, local):
    out = _run(["scp", "-q"] + SSH_OPTS + ["%s:%s" % (host, src), local])
    if out.returncode != 0:
        raise SystemExit("download failed (exit %d)" % out.returncode)


def verify(out_path):
    """Reuse the same structural check CI runs; a package that fails it is a
    broken delivery, not a warning."""
    checker = os.path.join(ROOT, "tools", "verify_fpk.py")
    out = _run([sys.executable, checker, out_path])
    if out.returncode != 0:
        raise SystemExit("verify_fpk failed (exit %d)" % out.returncode)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default=DEFAULT_HOST,
                    help="ssh alias / host (default: %s)" % DEFAULT_HOST)
    ap.add_argument("--workdir", default="/tmp/qbpanel-build")
    ap.add_argument("--deploy-dir", default=DEFAULT_DEPLOY_DIR,
                    help="device directory the package is copied to (default: %s)"
                    % DEFAULT_DEPLOY_DIR)
    ap.add_argument("--no-push", action="store_true",
                    help="build and verify only, leave the device directory alone")
    ap.add_argument("--no-verify", action="store_true",
                    help="skip the local verify_fpk.py step")
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
    wd = args.workdir.rstrip("/")

    tmp_tar = os.path.join(tempfile.gettempdir(), "qbpanel-src.tar")
    with tarfile.open(tmp_tar, "w") as tf:
        for name in sorted(os.listdir(SRC)):
            if name == "qbpanel.fpk":
                continue
            tf.add(os.path.join(SRC, name), arcname=name, filter=_skip)
    print("packed sources ->", tmp_tar)

    put(args.host, tmp_tar, REMOTE_TAR)

    # cmd/* and app/ui/index.cgi must stay executable or fnOS refuses the
    # install; every other member goes back to 644.
    remote(args.host, """set -eu
WD={wd}
rm -rf "$WD"
mkdir -p "$WD"
tar -xf {tar} -C "$WD"
cd "$WD"
find . -type d -exec chmod 755 {{}} \\;
find . -type f -exec chmod 644 {{}} \\;
chmod 755 cmd/* app/ui/index.cgi
fnpack build
ls -la {app}.fpk
""".format(wd=wd, tar=REMOTE_TAR, app=app))

    out_name = "%s-%s-fnos-%s.fpk" % (app, ver, plat)
    out_path = os.path.join(ROOT, out_name)
    get(args.host, "%s/%s.fpk" % (wd, app), out_path)
    print("built:", out_path, os.path.getsize(out_path), "bytes")

    if args.no_verify:
        print("--no-verify: skipped the structural check")
    else:
        verify(out_path)

    if args.no_push:
        print("--no-push: left %s untouched" % args.deploy_dir)
        return

    # The deploy directory is mode 000 on the test box but owned by the login
    # user, so a plain cp normally works; sudo -n is only a fallback.
    remote(args.host, """set -eu
mkdir -p {d}
cp -f {k} {d}/{app}-{v}.fpk 2>/dev/null || sudo -n cp -f {k} {d}/{app}-{v}.fpk
ls -la {d}/
""".format(d=args.deploy_dir.rstrip("/"), k="%s/%s.fpk" % (wd, app),
           app=app, v=ver))


if __name__ == "__main__":
    main()
