/* Interactive verification of the redesigned qbpanel UI over CDP.
 * Run: NODE_PATH=<workspace>/node_modules node tools/uishot.js [baseUrl]
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
      let b = "";
      r.on("data", (c) => (b += c));
      r.on("end", () => resolve(JSON.parse(b)));
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
      let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.id && c.pending.has(msg.id)) {
        const { res, rej } = c.pending.get(msg.id); c.pending.delete(msg.id);
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
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
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });

  const errors = [];
  await c.send("Log.enable").catch(() => {});
  c.ws.on("message", (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.method === "Runtime.exceptionThrown") errors.push(JSON.stringify(m.params.exceptionDetails).slice(0, 300));
  });

  async function shot(name) {
    const r = await c.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(OUT, name + ".png"), Buffer.from(r.data, "base64"));
    console.log("shot ->", name);
  }
  async function waitFor(expr, ms) {
    return c.eval(`new Promise(function(res){var t0=Date.now();var iv=setInterval(function(){var v=false;try{v=(${expr});}catch(e){v=false;}if(v){clearInterval(iv);res(true);}else if(Date.now()-t0>${ms || 15000}){clearInterval(iv);res(false);}},150);})`);
  }
  const click = (sel) => c.eval(`(function(){var e=document.querySelector(${JSON.stringify(sel)});if(!e)return false;e.click();return true;})()`);

  async function load(url, readyExpr) {
    await c.send("Page.navigate", { url: url });
    await waitFor(readyExpr || "!!document.querySelector('.side-foot')", 20000);
    await sleep(2200);
  }

  const root = BASE;

  await load(root + "/?view=dash&theme=light");
  await shot("u1_dash_light");

  await click(".side-foot .foot-row .icon-btn:nth-child(1)");
  await sleep(1400);
  await shot("u2_dash_dark");

  await click(".side-foot .foot-row .icon-btn:nth-child(1)");
  await sleep(1400);
  await shot("u3_dash_system");

  const langTip = await c.eval(`document.querySelectorAll('.side-foot .foot-row .icon-btn')[1].getAttribute('title')`);
  console.log("lang button title:", langTip);
  await click(".side-foot .foot-row .icon-btn:nth-child(2)");
  await sleep(1600);
  await shot("u4_dash_en");

  // back to zh for the remaining shots
  await click(".side-foot .foot-row .icon-btn:nth-child(2)");
  await sleep(1200);

  await click(".collapse-btn");
  await sleep(900);
  await shot("u5_collapsed");
  await click(".collapse-btn");
  await sleep(700);

  await load(root + "/?view=torrents&theme=light");
  await shot("u6_torrents");

  await click(".btn.primary");
  await sleep(900);
  await shot("u7_add_modal");
  await c.eval(`(function(){var bs=[].slice.call(document.querySelectorAll('.modal-foot .btn'));if(bs[0])bs[0].click();})()`);
  await sleep(600);

  await c.eval(`(function(){var e=document.querySelector('.ttable tbody tr .name');if(e)e.click();})()`);
  await waitFor("!!document.querySelector('.drawer')", 8000);
  await sleep(1800);
  await shot("u8_detail");

  await load(root + "/?view=settings&theme=dark");
  await shot("u9_settings_dark");

  await load(root + "/?view=servers&theme=light");
  await shot("u10_servers");

  await load(root + "/?view=stats&theme=light");
  await shot("u11_stats");

  const metrics = await c.eval(`JSON.stringify({
    navIconOffset: (function(){
      var i=document.querySelector('.nav-item .ic svg'), l=document.querySelector('.nav-item .label');
      if(!i||!l) return null;
      var a=i.getBoundingClientRect(), b=l.getBoundingClientRect();
      return { iconMid: Math.round(a.top+a.height/2), labelMid: Math.round(b.top+b.height/2) };
    })(),
    topBtnIconOffset: (function(){
      var btn=document.querySelector('.side-foot .foot-row .icon-btn');
      if(!btn) return null;
      var svg=btn.querySelector('svg');
      var a=btn.getBoundingClientRect(), b=svg.getBoundingClientRect();
      return { btnMid: Math.round(a.top+a.height/2), iconMid: Math.round(b.top+b.height/2),
               btnX: Math.round(a.left+a.width/2), iconX: Math.round(b.left+b.width/2) };
    })(),
    theme: document.documentElement.getAttribute('data-theme'),
    lang: document.documentElement.getAttribute('lang')
  })`);
  console.log("metrics:", metrics);
  console.log("pageErrors:", errors.length ? errors : "none");

  c.ws.close();
  console.log("done");
  process.exit(0);
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
