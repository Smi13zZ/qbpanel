/* Verification for the layout/palette fixes.
 * Run: NODE_PATH=<workspace>/node_modules node tools/fixshot.js [baseUrl]
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const PORT = 9333;
const OUT = "D:/Workspace WorkBuddy/qbpanel-fnos/_shots";
const BASE = process.argv[2] || "http://127.0.0.1:8898";

function httpJson(p) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port: PORT, path: p }, (r) => {
      let b = ""; r.on("data", (c) => (b += c)); r.on("end", () => resolve(JSON.parse(b)));
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
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error("timeout " + method)); } }, 30000);
    });
  }
  async eval(expr) {
    const r = await this.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const c = await CDP.connect();
  await c.send("Page.enable");
  await c.send("Runtime.enable");
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1500, height: 1080, deviceScaleFactor: 1, mobile: false });

  const errors = [];
  c.ws.on("message", (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.method === "Runtime.exceptionThrown") errors.push(JSON.stringify(m.params.exceptionDetails).slice(0, 200));
  });

  async function shot(n) {
    const r = await c.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(OUT, n + ".png"), Buffer.from(r.data, "base64"));
    console.log("shot ->", n);
  }
  async function waitFor(expr, ms) {
    return c.eval(`new Promise(function(res){var t0=Date.now();var iv=setInterval(function(){var v=false;try{v=(${expr});}catch(e){v=false;}if(v){clearInterval(iv);res(true);}else if(Date.now()-t0>${ms||15000}){clearInterval(iv);res(false);}},150);})`);
  }
  async function load(url, ready) {
    await c.send("Page.navigate", { url });
    await waitFor(ready || "!!document.querySelector('.side-foot')", 20000);
    await sleep(2200);
  }
  const cardHeights = `JSON.stringify([].slice.call(document.querySelectorAll('.grid.c2 > .card')).map(function(el){
      var r = el.getBoundingClientRect();
      return { top: Math.round(r.top), h: Math.round(r.height) };
    }))`;

  // --- dashboard (dark) ---
  await load(BASE + "/?view=dash&theme=dark", "!!document.querySelector('.grid.c2 > .card')");
  await shot("f1_dash_dark");
  console.log("dash 卡片几何:", await c.eval(cardHeights));

  // --- stats (dark) ---
  await load(BASE + "/?view=stats&theme=dark", "!!document.querySelector('.grid.c2 > .card')");
  await shot("f2_stats_dark");
  console.log("stats 卡片几何:", await c.eval(cardHeights));

  // --- palette probes ---
  const probe = await c.eval(`JSON.stringify({
    navActiveBg: getComputedStyle(document.querySelector('.nav-item.on')).backgroundColor,
    navActiveWeight: getComputedStyle(document.querySelector('.nav-item.on')).fontWeight,
    navWeight: getComputedStyle(document.querySelector('.nav-item')).fontWeight,
    navIconStroke: getComputedStyle(document.querySelector('.nav-item svg')).strokeWidth,
    pageBg: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
    sidebarBg: getComputedStyle(document.documentElement).getPropertyValue('--sidebar').trim()
  })`);
  console.log("dark 令牌:", probe);

  // --- torrents (dark): checkbox + row action buttons ---
  await load(BASE + "/?view=torrents&theme=dark", "!!document.querySelector('.ttable tbody tr')");
  await shot("f3_torrents_dark");
  const cb = await c.eval(`(function(){
    var cb=document.querySelector('.ttable input[type=checkbox]');
    var bs=[].slice.call(document.querySelectorAll('.ttable tbody tr .acts .btn'));
    var g=null;
    if (bs.length>1){ var a=bs[0].getBoundingClientRect(), b=bs[1].getBoundingClientRect(); g=Math.round(b.left-a.right); }
    return JSON.stringify({
      accent: cb?getComputedStyle(cb).accentColor:null,
      cbBox: cb?JSON.stringify(cb.getBoundingClientRect().toJSON()):null,
      actsGap: g,
      btn0: bs[0]?{w:Math.round(bs[0].getBoundingClientRect().width),border:getComputedStyle(bs[0]).borderTopColor}:null
    });
  })()`);
  console.log("复选框/操作按钮:", cb);

  // --- settings (dark): 二次确认 checkbox ---
  await load(BASE + "/?view=settings&theme=dark", "!!document.querySelector('.switch input[type=checkbox]')");
  await shot("f4_settings_dark");

  // --- light theme nav ---
  await load(BASE + "/?view=dash&theme=light", "!!document.querySelector('.nav-item.on')");
  await shot("f5_dash_light");
  console.log("light navActiveBg:", await c.eval(`getComputedStyle(document.querySelector('.nav-item.on')).backgroundColor`));

  console.log("pageErrors:", errors.length ? errors : "none");
  c.ws.close();
  console.log("done");
  process.exit(0);
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
