#!/usr/bin/env node
/* md.js 的单元测试（零依赖）。
 *
 * 两类断言，缺一不可：
 *   1. 渲染 —— Release 正文里真实会出现的语法必须真的变成标签
 *   2. 安全 —— 正文是外网内容，任何注入都必须被吃掉
 *
 * 用法: node tools/test_md.js <md.js 路径>
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const file = process.argv[2] ||
  path.join(__dirname, "..", "qbpanel", "app", "web", "js", "md.js");
const src = fs.readFileSync(file, "utf8");

const sandbox = { window: {} };
vm.createContext(sandbox);
new vm.Script(src, { filename: file }).runInContext(sandbox);
const MD = sandbox.window.MD;
if (!MD || typeof MD.render !== "function") {
  console.error("md.js 没有导出 MD.render");
  process.exit(1);
}

let pass = 0;
const fails = [];

function ok(name, cond, extra) {
  if (cond) { pass++; return; }
  fails.push(name + (extra ? " → " + extra : ""));
}

function has(name, out, needle) {
  ok(name, out.indexOf(needle) !== -1, "缺少 " + needle + "，实际: " + out.slice(0, 260));
}

function lacks(name, out, needle) {
  ok(name, out.indexOf(needle) === -1, "不该出现 " + needle + "，实际: " + out.slice(0, 260));
}

/* ---------------------------------------------------------------- 渲染 --- */

let h = MD.render("## 升级遮罩\n\n正文一句。");
has("二级标题成 <h2>", h, "<h2>升级遮罩</h2>");
lacks("标题里不留 ##", h, "##");

h = MD.render("# 一级\n### 三级\n###### 六级");
has("一级", h, "<h1>一级</h1>");
has("三级", h, "<h3>三级</h3>");
has("六级", h, "<h6>六级</h6>");

h = MD.render("- 阶段只允许前进\n- total 只增不减\n- 单调性按 attempt 重置");
has("无序列表 <ul>", h, "<ul>");
ok("三个 <li>", (h.match(/<li>/g) || []).length === 3, h);
has("列表项内容", h, "<li>阶段只允许前进</li>");

h = MD.render("1. 第一\n2. 第二");
has("有序列表 <ol>", h, "<ol>");
ok("有序列表三项数字不残留", h.indexOf("1. ") === -1, h);

h = MD.render("**加粗** 与 `代码` 与 *斜体*");
has("粗体", h, "<strong>加粗</strong>");
has("行内代码", h, "<code>代码</code>");
has("斜体", h, "<em>斜体</em>");
lacks("粗体不留星号", h, "**");

h = MD.render("见 [发布页](https://github.com/x/y/releases) 说明");
has("链接成 <a>", h, '<a href="https://github.com/x/y/releases"');
has("链接文字保留", h, ">发布页</a>");

h = MD.render("裸链接 https://example.com/a 在此");
has("裸链接成 <a>", h, '<a href="https://example.com/a"');
ok("裸链接只包一层", (h.match(/<a /g) || []).length === 1, h);

h = MD.render("```sh\nfnpack build\n```");
has("代码块 <pre>", h, '<pre class="md-code"');
has("代码块内容不被解释", h, "fnpack build");

h = MD.render("---");
has("分隔线", h, "<hr>");

h = MD.render("> 引用一句");
has("引用", h, "<blockquote>引用一句</blockquote>");

h = MD.render("第一段\n\n第二段");
ok("空行分段", (h.match(/<p>/g) || []).length === 2, h);

/* ---------------------------------------------------------------- 安全 --- */

h = MD.render('<script>alert(1)</script>');
lacks("script 标签被转义", h, "<script");
has("转义成实体", h, "&lt;script&gt;");

h = MD.render('<img src=x onerror="alert(1)">');
lacks("img 标签不落地", h, "<img");
has("onerror 只剩转义文本", h, "onerror=&quot;");

h = MD.render("[点我](javascript:alert(1))");
lacks("javascript: 链接不落地", h, "javascript:");
lacks("不生成空 href 的 a", h, "<a ");

h = MD.render("[点我](data:text/html;base64,PHNjcmlwdD4=)");
lacks("data: 链接不落地", h, "data:text/html");

h = MD.render("`<b>x</b>`");
lacks("行内代码里的标签也被转义", h, "<b>");

h = MD.render("![图](https://evil/x.png)");
lacks("外链图片不加载", h, "<img");
has("图片只留 alt", h, "图");

h = MD.render('<a href="https://x" onclick="evil()">t</a>');
lacks("手写 a 标签不落地", h, 'href="https://x"');

/* ------------------------------------------------------- 混合与边界 --- */

h = MD.render("");
ok("空串渲染成空", h === "", JSON.stringify(h));

h = MD.render(null);
ok("null 不炸", typeof h === "string", typeof h);

h = MD.render("## 标题\n\n- a\n- b\n\n正文 **x**");
has("标题+列表+段落共存", h, "<h2>标题</h2>");
has("列表共存", h, "<ul><li>a</li><li>b</li></ul>");
has("段落粗体共存", h, "<strong>x</strong>");

// 真实 Release 正文的形态（中文段 + 英文段 + 双语标题）
const real = [
  "## PVEpanel 26.11.25",
  "",
  "**升级遮罩的稳定性与文案**",
  "",
  "- 阶段只允许前进：检查 → 下载 → 校验 → 安装，晚到的旧快照整帧丢弃。",
  "- 新增「正在校验文件完整性」阶段，下载与安装之间的空档可见。",
  "- 装完改成等面板回来再刷新；重试超过 10 次放出「立即重新加载」按钮。",
  "",
  "**Upgrade overlay**",
  "",
  "- Phases only move forward.",
].join("\n");
h = MD.render(real);
has("真实正文：标题", h, "<h2>PVEpanel 26.11.25</h2>");
ok("真实正文：两个粗体小标题",
   (h.match(/<strong>/g) || []).length === 2, h);
ok("真实正文：两段共六个列表项", (h.match(/<li>/g) || []).length === 4, h);
lacks("真实正文：不留任何 ## 或 **", h.replace(/<[^>]+>/g, ""), "##");

if (fails.length) {
  console.error("FAIL " + fails.length + " / " + (pass + fails.length));
  fails.forEach(function (f) { console.error("  - " + f); });
  process.exit(1);
}
console.log("OK " + pass + " assertions");
