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
    #    这一条踩过两次，两次都是「看着齐了、换个字就不齐」：
    #    a) 只对齐墨迹中线：中线确实重合，但 14px 的地球墨迹比文字高 3.6px，
    #       上下各超出近 2px，看着像图标沉下去；
    #    b) 换成固定补偿 translateY(-1.5px)：那个像素值是照一种等宽字标定的，
    #       换一种等宽字，数字墨迹从 8.17px 变 8.71px，偏移立刻失准（实测偏 1.12px）。
    #    现在要求：对齐基线，尺寸与偏移一律用 em，并且禁止固定像素尺寸。
    if not re.search(r"\.ver-line\s*\{[^}]*line-height:\s*16px", css):
        fails.append("版本行没有 line-height: 16px（行盒比字形高小半行，图标会偏）")
    if not re.search(r"\.ver-line\s*\{[^}]*align-items:\s*baseline", css):
        fails.append("版本行没有 align-items: baseline（固定像素补偿会随字体失准）")
    rules = re.findall(r"\.ver-line\s+svg\s*\{([^}]*)\}", css)
    if not rules:
        fails.append("找不到 .ver-line svg 规则")
    else:
        if not any("em" in b and "translateY(" in b for b in rules):
            joined = " | ".join(b.strip()[:70] for b in rules)
            fails.append("版本行图标尺寸/偏移没用 em（换一种字就会偏：%s）" % joined)
        # 固定像素是那两次出错的共同形态，抓死它
        fixed = [b for b in rules
                 if re.search(r"(?:^|[;{\s])(?:width|height|flex)\s*:\s*[\d.]+px", b)]
        if fixed:
            fails.append("版本行图标写回了固定像素尺寸（%s）" % fixed[0].strip()[:70])
    # 图标盒子的尺寸也必须用 em：只改 svg、不改盒子，盒子仍按固定 px 占位，
    # 图标会被挤在中间，居中对齐时又回到「看着偏」的老问题。
    ic_rules = re.findall(r"\.ver-line\s+\.ic\b[^{]*\{([^}]*)\}", css)
    if not any("em" in b for b in ic_rules):
        fails.append("版本行图标盒子的尺寸没用 em（只改 svg 不够）")

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


    fails.extend(check_app_shell(css))

    fails.extend(check_icon_settings_gear())

    return fails


#: 齿轮左上角那段弧的起点，是这套图标里唯一能把它和太阳区分开的特征。
GEAR_MARK = "M19.4 15a1.65"
#: 太阳版「设置」的特征：圆 + 8 条从中心发散的短线，从 M12 2v3 起笔。
SUN_MARK = "M12 2v3"


def check_icon_settings_gear():
    """侧栏「设置」的图标必须是齿轮。

    太阳那套（圆 + 8 条短线）读起来是「亮度/主题」，不是「设置」；
    主题按钮自己走 sun / moon / monitor 三个独立键，不受影响。

    判据：
      1. app.js 里 settings 键存在
      2. settings 的图形命中齿轮特征
      3. settings 的图形不得命中太阳特征
      4. 主题用的 sun 键必须还在（防止顺手把主题图标一起删了）
    """
    fails = []
    try:
        src = io.open(APP_JS, encoding="utf-8", errors="replace").read()
    except OSError:
        return ["读不到 app.js，无法核对设置图标"]

    m = re.search(r"settings\s*:\s*svg\(\s*'([^']*)'", src)
    if not m:
        fails.append("app.js 里找不到 settings 图标定义")
    else:
        icon = m.group(1)
        if GEAR_MARK not in icon:
            fails.append("侧栏「设置」的图标不是齿轮（太阳那套读起来像亮度）")
        if SUN_MARK in icon:
            fails.append("侧栏「设置」的图标退回成太阳了")

    if "sun: svg(" not in src:
        fails.append("主题的 sun 图标不见了（换设置图标时误删）")

    return fails


def check_app_shell(css):
    """应用壳式布局：文档高度必须固定为视口高度。

    宿主按文档高度给应用框定尺寸，而外壳的 `min-height: 100vh` 又让文档随内容
    长高 —— 两者互相喂，框越撑越高，钉在 100vh 底边的侧栏底部被推出屏幕，
    概览页只剩上方一小块内容、下面一大片空白。

    实测（403x1155 视口）修复前各页文档高度：统计 4313 / 网络诊断 1974 /
    概览 1603 —— 分别 3.7 / 1.7 / 1.4 屏；修复后全部等于 1155。

    四条规则缺一不可，任一条缺失都会让文档重新长高：
      1. html, body 不能滚动（否则文档本身就能比视口高）
      2. 外壳用 height 而不是 min-height —— min-height 正是那个放大器
      3. 主栏的 min-height:0 —— flex 子项默认 min-height:auto 会拒绝缩小
      4. 内容区承担滚动，同样要 min-height:0
    """
    fails = []

    # 1) html, body 锁滚动
    rules = re.findall(r"html,\s*body\s*\{([^}]*)\}", css)
    if not rules:
        fails.append("找不到 html, body 规则")
    elif not any(re.search(r"overflow:\s*hidden", b) for b in rules):
        fails.append("html, body 没有 overflow: hidden（文档自己就能比视口高）")

    # 2) 外壳固定高度
    shell = re.findall(r"(?<![-\w.])\.shell\s*\{([^}]*)\}", css)
    if not shell:
        fails.append("找不到 %s 规则" % '.shell')
    else:
        body = " ".join(shell)
        if not re.search(r"(?<![-\w])height:\s*100vh", body):
            fails.append("%s 没有固定 height: 100vh（壳会随内容长高）" % '.shell')
        if re.search(r"min-height:\s*100vh", body):
            fails.append("%s 用回了 min-height: 100vh —— 那正是把页面越撑越长的原因"
                         % '.shell')
        if not re.search(r"min-height:\s*0", body):
            fails.append("%s 缺少 min-height: 0（会被内容顶高）" % '.shell')

    # 3) 主栏 min-height:0
    main = re.findall(r"(?<![-\w.])\.main\s*\{([^}]*)\}", css)
    if not main:
        fails.append("找不到 %s 规则" % '.main')
    elif not any(re.search(r"min-height:\s*0", b) for b in main):
        fails.append("%s 缺少 min-height: 0（flex 子项默认 auto，内容仍会撑高壳）"
                     % '.main')

    # 4) 内容区承担滚动
    content = re.findall(r"(?<![-\w.])\.content\s*\{([^}]*)\}", css)
    if not content:
        fails.append("找不到 %s 规则" % '.content')
    else:
        if not any(re.search(r"overflow-y:\s*auto", b) for b in content):
            fails.append("%s 没有 overflow-y: auto（长内容无处可滚，只能撑高文档）"
                         % '.content')
        if not any(re.search(r"min-height:\s*0", b) for b in content):
            fails.append("%s 缺少 min-height: 0（长内容会顶高主栏）" % '.content')

    return fails


if __name__ == "__main__":
    sys.exit(main())
