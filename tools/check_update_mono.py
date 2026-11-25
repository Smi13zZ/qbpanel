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

    if not check_notes_and_log(src):
        return 1

    extra = check_indeterminate_and_verline()
    if extra:
        for item in extra:
            print("FAIL", item)
        return 1

    print("OK   升级进度收敛规则齐备（阶段只前进 / total 只增 / attempt 隔离）")
    return 0


def check_notes_and_log(src):
    """Release 正文渲染与安装日志展示的约束。

    这几条都是用户投诉或自踩之后补上的：
      1. Release 正文经 md.js 渲染（原先用正则剥掉语法，把结构也一起丢了）
      2. index.html 引入 md.js
      3. 安装日志只在失败时展开
      4. 后端清洗 appcenter-cli 的转圈帧（否则卡片上全是 stopping... 阶梯）
    """
    fails = []
    web = os.path.join(REPO, "qbpanel", "app", "web")
    html_path = os.path.join(web, "index.html")
    html = ""
    if os.path.isfile(html_path):
        html = io.open(html_path, encoding="utf-8").read()

    if "window.MD.render" not in src:
        fails.append("Release 正文没有走 md.js 渲染")
    if html and "js/md.js" not in html:
        fails.append("index.html 没有引入 js/md.js")
    if not os.path.isfile(os.path.join(web, "js", "md.js")):
        fails.append("缺少 web/js/md.js")

    for line in html.splitlines():
        if "upinstalllog" in line and "v-if=" in line and "updateError" not in line:
            fails.append("安装日志没有绑在 updateError 上（升级途中会一直显示）")
            break

    py = os.path.join(REPO, "qbpanel", "app", "server", "qbpanel.py")
    back = io.open(py, encoding="utf-8").read()
    if "clean_install_log" not in back:
        fails.append("后端没有 clean_install_log（转圈帧会原样进界面）")
    elif "clean_install_log(f.read())" not in back:
        fails.append("update_status 没有调用 clean_install_log")

    for f in fails:
        print("FAIL", f)
    return not fails


def check_indeterminate_and_verline():
    """不确定态进度条 + 版本行图标对齐。

    两条都是「实测过才定下来的数值」，删掉会以同样的形态回来：

    1. 遮罩在检查 / 校验 / 安装阶段没有可测总量，原先显示一句静态的
       「准备中…」。它看不出「还在动」，而且与上方阶段文字
       （「安装包已就绪，正在重启服务…」）语义打架。改成一条来回流动的
       条，颜色取 var(--primary) —— 浅色主题近黑、深色主题近白，自动反色。
    2. 版本行的地球图标与版本文字：flex 的 align-items:center 对齐的是
       行盒，而数字墨迹偏上、默认行高又比字形高小半行，实测图标低
       2.0–2.3px。收窄行高 + 图标上移 1px 后降到 0.0–0.33px。
    """
    fails = []
    css_path = os.path.join(REPO, "qbpanel", "app", "web", "style.css")
    css = io.open(css_path, encoding="utf-8").read() if os.path.isfile(css_path) else ""
    if not css:
        fails.append("找不到 style.css，无法核对遮罩样式")
    

    # 1) 不确定态：必须有 .upprog.indeterminate 与流动动画
    #    这里一律用「选择器 + 大括号 + 关键声明」精确匹配。
    #    裸子串会把 @media 里的 .upprog.indeterminate .upprog-flow 也算进来，
    #    删掉主规则后仍然判过 —— 变异测试抓过这个洞。
    if not re.search(r"\.upprog\.indeterminate\s*\{[^}]*\}", css):
        fails.append("缺少 .upprog.indeterminate 规则（不确定态退回静态文字）")
    if not re.search(r"\.upprog\.indeterminate\s+\.upprog-flow\s*\{[^}]*\}", css):
        fails.append("缺少 .upprog-flow 规则（那条流动的亮条）")
    if not re.search(r"@keyframes\s+upprogFlow\s*\{", css):
        fails.append("缺少 upprogFlow 动画（条不会动，等于还是静态）")
    # 动画必须真的被挂到流动条上
    m = re.search(r"\.upprog\.indeterminate\s+\.upprog-flow\s*\{([^}]*)\}", css)
    if m and "animation" not in m.group(1):
        fails.append(".upprog-flow 没有挂动画")
    # 颜色必须走主题变量，不能写死蓝色或黑色
    if m:
        body = m.group(1)
        if "var(--primary)" not in body:
            fails.append("不确定条没有用 var(--primary)（夜间模式不会反色）")
        for hard in ("#3b82f6", "#2563eb", "#000", "#111", "rgb(0, 0, 0)"):
            if hard in body:
                fails.append("不确定条写死了颜色 %s（夜间模式不会反色）" % hard)
    # 关掉动效时必须退回静止条，不能继续动
    # 同样要精确到「那条 reduced-motion 媒体查询里确实改了 .upprog-flow」
    rm = re.search(r"@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{"
                   r"[\s\S]{0,400}?\.upprog-flow[\s\S]{0,200}?\}", css)
    if not rm:
        fails.append("缺少 prefers-reduced-motion 兜底（前庭敏感用户会不适）")
    elif "animation: none" not in rm.group(0):
        fails.append("reduced-motion 兜底里没有关掉动画")

    # 2) 版本行对齐
    #    只对齐中线不够：14px 的地球墨迹有 11.8px 高、文字只有 8.2px，
    #    上下各超出 1.75px，看起来像图标沉下去了。11px 时两者同高
    #    （9.2 vs 8.2），中线差 0.0~0.35，上下超出对称在 0.5px 内。
    if not re.search(r"\.ver-line\s*\{[^}]*line-height:\s*16px", css):
        fails.append("版本行没有 line-height: 16px（图标会比文字低 2px）")
    # 注意：样式表里还有一条 `.side .ver-line svg { stroke-width }` 排在前面，
    # 用单次 re.search 会先命中它（它不含 width），于是永远判失败。
    # 这里取全部同名规则，只要有一条同时带 width 与 translateY 就通过。
    rules = re.findall(r"\.ver-line\s+svg\s*\{([^}]*)\}", css)
    if not rules:
        fails.append("找不到 .ver-line svg 规则")
    elif not any("width: 11px" in b and "translateY(-1.5px)" in b for b in rules):
        joined = " | ".join(b.strip()[:70] for b in rules)
        fails.append("版本行图标不是 11px / translateY(-1.5px)（实际：%s）" % joined)

    # 3) 「检查更新」按钮的旋转图标
    #    检查是一段持续状态，图标要一直转；用 animation 而不是 transition。
    # 注意两个坑（都是变异测试抓出来的）：
    #   a) reduced-motion 里也有一条同选择器的 `{ animation: none; }`，
    #      用单次 search 会先命中它，主规则删掉也能过 —— 必须要求动画名是 checkSpin。
    #   b) 关键帧用 `in` 做子串判断，改名成 checkSpinXX 仍是前缀，必须正则 + 边界。
    spin_rules = re.findall(r"\.btn\s+\.ic\.spinning\s+svg\s*\{([^}]*)\}", css)
    if not any("checkSpin" in b and "animation" in b for b in spin_rules):
        fails.append("检查按钮缺少 .btn .ic.spinning 的 checkSpin 旋转动画")
    if not re.search(r"@keyframes\s+checkSpin\s*\{", css):
        fails.append("缺少 checkSpin 关键帧（图标不会转）")
    # 关掉动效时要退回静止，不能一直转
    if not re.search(r"prefers-reduced-motion[\s\S]{0,400}?spinning[\s\S]{0,200}?animation:\s*none",
                     css):
        fails.append("缺少 spinning 的 reduced-motion 兜底")


    # 4) 按钮图标容器必须有显式尺寸
    #    有的产品的图标是 <svg viewBox="0 0 24 24"> 不带 width/height 属性，
    #    尺寸全靠 CSS；没有这条规则会塌成 0，按钮上只剩文字。
    if not re.search(r"\.btn\s+\.ic\s*\{[^}]*width:\s*16px", css):
        fails.append("缺少 .btn .ic 的显式尺寸（图标宽度会塌成 0）")

    return fails


if __name__ == "__main__":
    sys.exit(main())
