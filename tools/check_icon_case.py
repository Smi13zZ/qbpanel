#!/usr/bin/env python3
"""check_icon_case.py - 挡住「大小写不敏感文件系统吞文件」的问题。

Windows / macOS 默认不区分文件名大小写，而 Linux 区分。仓库里同时存在
`icon_64.png` 与 `ICON_64.PNG` 这种只差大小写的名字时：
  * 本地写 icon_64.png 会直接覆盖到 ICON_64.PNG 上，看着「写成功了」，
    其实只是同一张文件换了个显示名；
  * git 因为 core.ignorecase=true，认为「文件没变」，压根不会把它加进索引；
  * 于是 CI 从仓库 checkout 出来的包里就没有这个尺寸。

这个脚本检查两件事：
  1. app/ui/images 下不允许出现只差大小写的重名文件；
  2. ui/config 的 icon 占位符涉及的每个尺寸，都必须真的在 git 索引里。
"""
import json
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
IMAGES = os.path.join(ROOT, "qbpanel", "app", "ui", "images")
SIZES = [16, 24, 48, 64, 72, 96, 128, 256, 512]


def fail(msg):
    print("FAIL:", msg)
    sys.exit(1)


def main():
    if not os.path.isdir(IMAGES):
        fail("找不到 %s" % IMAGES)

    # 1. 只差大小写的重名
    seen = {}
    for name in os.listdir(IMAGES):
        key = name.lower()
        if key in seen and seen[key] != name:
            fail("文件名只差大小写，在不区分大小写的系统上会互相覆盖：%s / %s"
                 % (seen[key], name))
        seen[key] = name

    # 2. 每个尺寸都要在 git 索引里
    cfg_path = os.path.join(ROOT, "qbpanel", "app", "ui", "config")
    cfg = json.loads(open(cfg_path, encoding="utf-8").read())
    icon_tpl = cfg[".url"]["fn-qbpanel.Application"]["icon"]
    if "{0}" not in icon_tpl:
        print("OK   icon 不使用尺寸占位符，跳过尺寸检查：%s" % icon_tpl)
        return

    try:
        tracked = subprocess.run(
            ["git", "-C", ROOT, "ls-files", "--", "qbpanel/app/ui/images"],
            capture_output=True, text=True, timeout=30)
        tracked_set = set(tracked.stdout.split())
    except Exception as exc:
        print("WARN 无法读取 git 索引（%s），跳过跟踪检查" % exc)
        tracked_set = None

    missing_disk = []
    missing_git = []
    for size in SIZES:
        rel = "ui/" + icon_tpl.replace("{0}", str(size))
        base_name = os.path.basename(rel)
        disk = os.path.join(IMAGES, base_name)
        if not os.path.isfile(disk):
            missing_disk.append(base_name)
        if tracked_set is not None:
            if ("qbpanel/app/ui/images/" + base_name) not in tracked_set:
                missing_git.append(base_name)

    if missing_disk:
        fail("磁盘上缺少这些尺寸：%s（跑 python tools/make_icons.py）"
             % ", ".join(missing_disk))
    if missing_git:
        fail("这些尺寸没有被 git 跟踪，打包时不会进包：%s"
             % ", ".join(missing_git))

    print("OK   app/ui/images 无大小写重名，九档尺寸齐全且都在 git 索引里")


if __name__ == "__main__":
    main()