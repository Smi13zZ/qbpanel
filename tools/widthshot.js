/* Checks the torrent list across viewport widths.
 * Run: NODE_PATH=<workspace>/node_modules node tools/widthshot.js [baseUrl]
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
  // reusing one CDP browser session means style.css can come from the memory
  // cache and hide every CSS change - always bypass it while verifying
  await c.send("Network.enable");
  await c.send("Network.setCacheDisabled", { cacheDisabled: true });

  const errors = [];
  c.ws.on("message", (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.method === "Runtime.exceptionThrown") errors.push(JSON.stringify(m.params.exceptionDetails).slice(0, 200));
  });
  async function waitFor(expr, ms) {
    return c.eval(`new Promise(function(res){var t0=Date.now();var iv=setInterval(function(){var v=false;try{v=(${expr});}catch(e){v=false;}if(v){clearInterval(iv);res(true);}else if(Date.now()-t0>${ms||15000}){clearInterval(iv);res(false);}},150);})`);
  }

  const probe = `(function(){
    var tb = document.querySelector('.ttable.tlist');
    if (!tb) return JSON.stringify({mobile:true});
    var wrap = tb.parentElement;
    var ths = [].slice.call(tb.querySelectorAll('thead th')).filter(function(x){return x.offsetParent!==null});
    var nm = tb.querySelector('tbody .name');
    var pm = tb.querySelector('tbody .pmeta');
    var bar = tb.querySelector('tbody .progress');
    return JSON.stringify({
      cols: ths.length,
      headers: ths.map(function(x){return (x.textContent||'☑').trim()}).join('/'),
      nameW: nm ? Math.round(nm.getBoundingClientRect().width) : null,
      pmetaLines: pm ? Math.round(pm.getBoundingClientRect().height) : null,
      barW: bar ? Math.round(bar.getBoundingClientRect().width) : null,
      overflow: wrap.scrollWidth - wrap.clientWidth
    });
  })()`;

  for (const w of [1600, 1400, 1200, 1160, 1140, 1100, 980, 820]) {
    await c.send("Emulation.setDeviceMetricsOverride", { width: w, height: 900, deviceScaleFactor: 1, mobile: false });
    await c.send("Page.navigate", { url: BASE + "/?view=torrents&theme=dark" });
    await waitFor("!!document.querySelector('.ttable.tlist tbody tr') || !!document.querySelector('.tcard')", 20000);
    await sleep(2200);
    const r = JSON.parse(await c.eval(probe));
    console.log(String(w).padStart(5) + "px  " + JSON.stringify(r));
    const shot = await c.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(OUT, "w" + w + ".png"), Buffer.from(shot.data, "base64"));
  }
  console.log("pageErrors:", errors.length ? errors : "none");
  c.ws.close();
  console.log("done");
  process.exit(0);
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
