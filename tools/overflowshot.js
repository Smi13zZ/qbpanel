/* Overflow finder: at a phone-width window, walk every view and list the
 * elements whose box extends beyond the document's client width (or before
 * its left edge) - i.e. whoever pushes the page into horizontal scroll.
 * Run: PORT=9334 NODE_PATH=<workspace>/node_modules node tools/overflowshot.js
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const PORT = parseInt(process.env.PORT || "9334", 10);
const OUT = "D:/Workspace WorkBuddy/qbpanel-fnos/_shots";
const BASE = "http://127.0.0.1:8898";
const VIEWS = ["dash", "torrents", "servers", "stats", "logs", "settings"];

function httpJson(p) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port: PORT, path: p }, (r) => {
      let b = ""; r.on("data", (c) => (b += c));
      r.on("end", () => { try { resolve(JSON.parse(b)); } catch (e) { resolve(null); } });
    }).on("error", reject);
  });
}
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
  static async connect() {
    const list = await httpJson("/json/list");
    const page = list.find((t) => t.type === "page");
    if (!page) throw new Error("no page target");
    const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
    await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
    const c = new CDP(ws);
    ws.on("message", (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.id && c.pending.has(m.id)) {
        const { res, rej } = c.pending.get(m.id); c.pending.delete(m.id);
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
      }
    });
    return c;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error("timeout " + method)); } }, 25000);
    });
  }
  async eval(expr) {
    const r = await this.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true });
    if (r.exceptionDetails) throw new Error("EVAL: " + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text || "").slice(0, 240));
    return r.result.value;
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FINDER = `(function(){
  var vw = document.documentElement.clientWidth;
  var doc = document.documentElement;
  var out = { vw: vw, scrollW: doc.scrollWidth, innerW: window.innerWidth,
              offenders: [] };
  var all = document.querySelectorAll('*');
  for (var i = 0; i < all.length; i++) {
    var el = all[i];
    var r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if (r.right > vw + 1 || r.left < -1) {
      var st = getComputedStyle(el);
      // skip elements inside a horizontally-scrollable ancestor on purpose
      // (e.g. a pre/code block that scrolls internally)
      var p = el.parentElement, inScroller = false;
      while (p && p !== document.body) {
        var ps = getComputedStyle(p);
        if (ps.overflowX === 'auto' || ps.overflowX === 'scroll') { inScroller = true; break; }
        p = p.parentElement;
      }
      if (inScroller) continue;
      out.offenders.push({
        tag: el.tagName.toLowerCase(),
        cls: String(el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className).slice(0, 60),
        left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width),
        pos: st.position, ovr: st.overflowX,
        txt: (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 50)
      });
    }
  }
  // keep the widest few
  out.offenders.sort(function(a, b){ return b.right - a.right; });
  out.offenders = out.offenders.slice(0, 8);
  return JSON.stringify(out);
})()`;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const c = await CDP.connect();
  await c.send("Page.enable");
  await c.send("Runtime.enable");
  await c.send("Network.enable");
  await c.send("Network.setCacheDisabled", { cacheDisabled: true });

  // Windows Edge refuses windows narrower than ~500px, so to measure a real
  // phone viewport (360-414) we must use the CDP override. HANDOFF's warning
  // about stale composited layers affects SCREENSHOTS and computed-style
  // sampling - plain layout geometry (getBoundingClientRect / scrollWidth)
  // follows the override faithfully, which is all this script reads.
  const FORCE_W = parseInt(process.env.FORCE_W || "360", 10);
  await c.send("Emulation.setDeviceMetricsOverride", {
    width: FORCE_W, height: 740, deviceScaleFactor: 2, mobile: true,
  });

  let bad = false;
  for (const v of VIEWS) {
    await c.send("Page.navigate", { url: BASE + "/?view=" + v });
    await sleep(1600);
    const res = JSON.parse(await c.eval(FINDER));
    const flag = res.scrollW > res.vw + 1 ? "OVERFLOW" : "clean  ";
    console.log(`[${flag}] view=${v}  vw=${res.vw} scrollW=${res.scrollW} innerW=${res.innerW}`);
    if (res.scrollW > res.vw + 1) {
      bad = true;
      res.offenders.forEach((o) => {
        console.log(`    <${o.tag} class="${o.cls}"> left=${o.left} right=${o.right} w=${o.w} pos=${o.pos} :: ${o.txt}`);
      });
    }
  }
  console.log(bad ? "\n[OVERFLOW FOUND]" : "\n[ALL CLEAN]");
  process.exit(0);
})().catch((e) => { console.error("FATAL", e.message); process.exit(2); });
