/* 一个够用的 Markdown 渲染器（零依赖）。
 *
 * Release 正文是外网拉回来的不可信内容，所以顺序不能反：先整体 HTML 转义，
 * 再在已经安全的地基上套标签。任何「先渲染再清理」的实现都会在
 * <img onerror=>、javascript: 链接这类地方漏掉。
 *
 * 只实现 Release 正文真实会用到的语法，不做完整 CommonMark：
 *   块级  # 标题 / - 无序列表 / 1. 有序列表 / > 引用 / ``` 代码块 / --- 分隔线 / 段落
 *   行内  **粗** *斜* `代码` [文字](链接) 裸链接 ~~删除~~
 *
 * 不支持的东西一律按纯文本显示，宁可少渲染也不要渲染错：
 * HTML 内联、表格、脚注、嵌套列表；图片只保留 alt 文字（面板不去抓外链图片，
 * 那等于把访问记录实时告诉发布者）。
 */
(function (root) {
  "use strict";

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  /* 链接只放行 http/https/mailto 与站内锚点。javascript:、data:、vbscript:
     一旦进了 href，点一下就是在面板域名下执行任意脚本。 */
  function safeHref(raw) {
    var url = String(raw || "").trim();
    if (!url) return "";
    if (url.charAt(0) === "#") return url;
    if (/^https?:\/\//i.test(url)) return url;
    if (/^mailto:/i.test(url)) return url;
    return "";
  }

  /* 行内标记。输入必须已经过 escapeHtml。
     链接与行内代码都先换成占位符：否则 `**a**` 里的星号会把一个已经是 <a>
     的片段再包一层，生成嵌套标签；裸链接的保护同理。 */
  function inline(text) {
    var kept = [];

    function keep(html) {
      kept.push(html);
      return "\u0000" + (kept.length - 1) + "\u0000";
    }

    var out = text;

    // 1. 行内代码最优先，里面的东西一律不解释
    out = out.replace(/`([^`]+)`/g, function (_, code) {
      return keep("<code>" + code + "</code>");
    });

    // 2. 图片：只留 alt 文字
    out = out.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");

    // 3. Markdown 链接。地址不合法就退化成纯文字，不留空 href。
    out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (_, label, href) {
      var safe = safeHref(href);
      if (!safe) return label;
      return keep('<a href="' + safe + '" target="_blank" rel="noopener noreferrer">' +
        label + "</a>");
    });

    // 4. 裸链接。此时所有 Markdown 链接都已经是占位符，不会重复包一层。
    out = out.replace(/(^|[\s(（])(https?:\/\/[^\s<>()（）]+)/g, function (_, pre, url) {
      var safe = safeHref(url);
      if (!safe) return pre + url;
      return pre + keep('<a href="' + safe + '" target="_blank" rel="noopener noreferrer">' +
        url + "</a>");
    });

    // 5. 粗体 / 斜体 / 删除线。先长后短，避免 ** 被单个 * 抢先匹配。
    out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    out = out.replace(/__([^_]+)__/g, "<strong>$1</strong>");
    out = out.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
    out = out.replace(/~~([^~]+)~~/g, "<del>$1</del>");

    // 6. 还原占位符（可能多轮，因为占位符本身不含嵌套）
    var guard = 0;
    while (/\u0000\d+\u0000/.test(out) && guard++ < 10) {
      out = out.replace(/\u0000(\d+)\u0000/g, function (_, i) {
        return kept[Number(i)] !== undefined ? kept[Number(i)] : "";
      });
    }
    return out;
  }

  function inlineBlock(text) {
    return inline(escapeHtml(text)).replace(/\n/g, "<br>");
  }

  var RE_UL = /^\s{0,3}[-*+]\s+/;
  var RE_OL = /^\s{0,3}\d+[.)]\s+/;
  var RE_HR = /^\s{0,3}([-*_])\s*\1\s*\1[\s\1]*$/;
  var RE_H = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
  var RE_FENCE = /^\s{0,3}(```|~~~)\s*([\w+#.-]*)\s*$/;
  var RE_QUOTE = /^\s{0,3}>\s?/;

  function render(src) {
    var lines = String(src === undefined || src === null ? "" : src)
      .replace(/\r\n?/g, "\n")
      .split("\n");

    var html = [];
    var para = [];
    var i = 0;
    var n = lines.length;

    function flushParagraph() {
      if (!para.length) return;
      html.push("<p>" + inlineBlock(para.join("\n")) + "</p>");
      para.length = 0;
    }

    while (i < n) {
      var line = lines[i];

      if (!line.trim()) {
        flushParagraph();
        i++;
        continue;
      }

      // 代码块：围栏内一个字符都不解释
      var fm = RE_FENCE.exec(line);
      if (fm) {
        flushParagraph();
        var lang = fm[2] || "";
        var buf = [];
        i++;
        while (i < n && !RE_FENCE.test(lines[i])) {
          buf.push(lines[i]);
          i++;
        }
        i++; // 跳过收尾围栏；没有收尾也照常闭合
        html.push('<pre class="md-code"' +
          (lang ? ' data-lang="' + escapeHtml(lang) + '"' : "") +
          "><code>" + escapeHtml(buf.join("\n")) + "</code></pre>");
        continue;
      }

      if (RE_HR.test(line)) {
        flushParagraph();
        html.push("<hr>");
        i++;
        continue;
      }

      var hm = RE_H.exec(line);
      if (hm) {
        flushParagraph();
        var lv = hm[1].length;
        html.push("<h" + lv + ">" + inline(escapeHtml(hm[2])) + "</h" + lv + ">");
        i++;
        continue;
      }

      if (RE_QUOTE.test(line)) {
        flushParagraph();
        var qbuf = [];
        while (i < n && RE_QUOTE.test(lines[i])) {
          qbuf.push(lines[i].replace(RE_QUOTE, ""));
          i++;
        }
        html.push("<blockquote>" + inlineBlock(qbuf.join("\n")) + "</blockquote>");
        continue;
      }

      if (RE_UL.test(line) || RE_OL.test(line)) {
        flushParagraph();
        var ordered = RE_OL.test(line);
        var re = ordered ? RE_OL : RE_UL;
        var items = [];
        while (i < n && re.test(lines[i])) {
          var parts = [lines[i].replace(re, "")];
          i++;
          /* 缩进的续行算同一个列表项：正文里换行写长句子很常见，
             当成新段落会把列表拆成碎片。 */
          while (i < n && lines[i].trim() && !re.test(lines[i]) &&
                 /^\s{2,}/.test(lines[i]) &&
                 !RE_H.test(lines[i]) && !RE_FENCE.test(lines[i])) {
            parts.push(lines[i].trim());
            i++;
          }
          items.push("<li>" + inlineBlock(parts.join("\n")) + "</li>");
        }
        html.push("<" + (ordered ? "ol" : "ul") + ">" + items.join("") +
          "</" + (ordered ? "ol" : "ul") + ">");
        continue;
      }

      para.push(line);
      i++;
    }
    flushParagraph();

    return html.join("\n");
  }

  root.MD = { render: render, escapeHtml: escapeHtml, safeHref: safeHref };
})(typeof window !== "undefined" ? window : this);
