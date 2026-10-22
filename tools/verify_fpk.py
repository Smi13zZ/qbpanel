#!/usr/bin/env python3
"""verify_fpk.py - 检查打好的 .fpk 是否结构完整、权限正确。

用在 CI 里挡住「包能打出来但装不上」的情况，本地手动打包也能直接跑：

    python tools/verify_fpk.py fn-qbpanel-26.10.23-fnos-all.fpk

包结构（fnOS 1.2.x 打出来的样子）：
    外层 .fpk   : manifest / app.tgz / cmd/* / config/* / wizard/* / ICON*.PNG
    内层 app.tgz: app/ 目录下的 server/ ui/ web/ 等内容（ui/index.cgi 必须可执行）

检查项：
  * 外层与内层的关键文件都在
  * manifest 里的 version 与文件名里的版本号一致
  * cmd/* 与 app.tgz 里的 ui/index.cgi 带可执行位
"""
import io
import os
import re
import sys
import tarfile


def fail(msg):
    print("FAIL:", msg)
    sys.exit(1)


def manifest_field(text, key):
    for line in text.splitlines():
        s = line.strip()
        if s.startswith(key) and "=" in s:
            return s.split("=", 1)[1].strip()
    return ""


def main():
    if len(sys.argv) < 2:
        fail("usage: verify_fpk.py <file.fpk>")
    path = sys.argv[1]
    if not os.path.isfile(path):
        fail("not found: %s" % path)

    with tarfile.open(path) as outer:
        members = {m.name: m for m in outer.getmembers()}
        for need in ("manifest", "app.tgz", "cmd", "config", "wizard", "ICON.PNG", "ICON_256.PNG"):
            if need not in members:
                fail("outer archive is missing %s" % need)

        manifest = outer.extractfile("manifest").read().decode("utf-8", "replace")
        version = manifest_field(manifest, "version")
        appname = manifest_field(manifest, "appname")
        platform = manifest_field(manifest, "platform")
        if not version:
            fail("manifest has no version")
        m = re.search(r"-(\d+\.\d+\.\d+)-fnos-", os.path.basename(path))
        if m and m.group(1) != version:
            fail("file name version %s != manifest version %s" % (m.group(1), version))

        cmd = [mm for n, mm in members.items() if n.startswith("cmd/") and mm.isfile()]
        if not cmd:
            fail("outer archive has no cmd/ scripts")
        bad = [mm.name for mm in cmd if not mm.mode & 0o111]
        if bad:
            fail("cmd scripts lost their executable bit: %s" % ", ".join(bad))

        inner = tarfile.open(fileobj=io.BytesIO(outer.extractfile("app.tgz").read()))
        inner_members = {mm.name: mm for mm in inner.getmembers()}
        for need in ("ui/index.cgi", "server/qbpanel.py", "server/backends.py",
                     "server/notify.py", "web/index.html", "web/js/app.js", "web/style.css"):
            if need not in inner_members:
                fail("app.tgz is missing %s" % need)
        mode = inner_members["ui/index.cgi"].mode
        if not mode & 0o111:
            fail("ui/index.cgi is not executable (mode %s)" % oct(mode))

    print("OK  %s" % os.path.basename(path))
    print("    appname=%s version=%s platform=%s" % (appname, version, platform))
    print("    外层 %d 项 / app.tgz %d 项，cmd+index.cgi 可执行位正常"
          % (len(members), len(inner_members)))
    print("    size=%d bytes" % os.path.getsize(path))


if __name__ == "__main__":
    main()
