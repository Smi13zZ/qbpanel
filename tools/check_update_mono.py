#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""升级进度收敛规则的静态闸门。

三条规则是「点一键更新后卡在遮罩里」的直接成因，删掉任何一条故障都会回来：

  1. 阶段只允许前进（checking < downloading < verifying < installing）
  2. total 只增不减，且只在 downloading 分支内累积
  3. 单调性只在同一 attempt 内成立（attempt 变了必须整体重置）

用法：python3 tools/check_update_mono.py
"""
import io
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
APP_JS = os.path.join(REPO, "qbpanel", "app", "web", "js", "app.js")


def slice_function(text, marker):
    start = text.find(marker)
    if start < 0:
        return ""
    brace = text.find("{", start)
    depth = 0
    for i in range(brace, len(text)):
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                return text[start:i + 1]
    return ""


def main():
    src = io.open(APP_JS, encoding="utf-8").read()
    body = slice_function(src, "applyUpdateState: function")
    fails = []

    if not body:
        print("FAIL 找不到 applyUpdateState")
        return 1

    if not re.search(r"checking\s*:\s*0", body):
        fails.append("规则 1 缺少阶段顺序表")
    if "nextRank < prevRank" not in body:
        fails.append("规则 1 缺少「后退快照丢弃」")
    if "updateMonoAttempt" not in body:
        fails.append("规则 3 缺少 attempt 基线")
    if "attempt !== this.updateMonoAttempt" not in body:
        fails.append("规则 3 缺少「attempt 变了就重置」")
    if 'rawPhase === "downloading"' not in body:
        fails.append("规则 2 缺少 downloading 分支")
    if "Math.max(this.updateProgressTotal || 0, st.total)" not in body:
        fails.append("规则 2 下载阶段没有用 Math.max 累积 total")
    if "update.verifying" not in body:
        fails.append("缺少校验阶段文案")
    if "reloadWhenBack" not in src:
        fails.append("缺少 reloadWhenBack（装完直接 reload 会撞进离线窗口）")

    finish = slice_function(src, "finishUpdate: function")
    if finish and "reloadWhenBack" not in finish:
        fails.append("finishUpdate 没有走 reloadWhenBack")

    if fails:
        for f in fails:
            print("FAIL", f)
        return 1
    print("OK   升级进度收敛规则齐备（阶段只前进 / total 只增 / attempt 隔离）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
