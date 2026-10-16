/* Desktop + phone verification for the backup UI and mobile adaptation.
 * Run: NODE_PATH=<workspace>/node_modules node tools/bkshot.js [baseUrl]
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

  const errors = [];
  c.ws.on("message", (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.method === "Runtime.exceptionThrown") errors.push(JSON.stringify(m.params.exceptionDetails).slice(0, 240));
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
  async function viewport(w, h, mobile) {
    await c.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, mobile: !!mobile });
  }
  async function load(url, ready, wait) {
    await c.send("Page.navigate", { url: url });
    await waitFor(ready || "!!document.querySelector('.side-foot')", 20000);
    await sleep(wait || 2000);
  }

  /* ---------- desktop: backup section ---------- */
  await viewport(1500, 1560, false);
  await load(BASE + "/?view=settings&theme=light", "!!document.querySelector('.kv')", 2600);
  await shot("b1_settings_desktop");
  const bkVisible = await c.eval(`(function(){
    var cards=[].slice.call(document.querySelectorAll('.card h3')).map(function(h){return h.textContent.trim();});
    return cards.join(' | ');
  })()`);
  console.log("settings cards:", bkVisible);

  const list = await c.eval(`(function(){
    var b=document.querySelector('.card .ttable tbody tr td.mono');
    return b ? b.textContent.trim() : '(none)';
  })()`);
  console.log("first backup row:", list);

  /* ---------- phone ---------- */
  await viewport(390, 844, true);
  await load(BASE + "/?view=dash&theme=light", "!!document.querySelector('.stat')", 2400);
  await shot("b2_phone_dash");

  await load(BASE + "/?view=torrents&theme=light", "!!document.querySelector('.tcard')", 2600);
  await shot("b3_phone_torrents");
  const cards = await c.eval(`document.querySelectorAll('.tcard').length`);
  const tableHidden = await c.eval(`!document.querySelector('.ttable')`);
  console.log("phone torrent cards:", cards, "| table hidden:", tableHidden);

  await click(".btn.primary");
  await sleep(1000);
  await shot("b4_phone_add_sheet");
  await c.eval(`(function(){var bs=[].slice.call(document.querySelectorAll('.modal-foot .btn'));if(bs[0])bs[0].click();})()`);
  await sleep(700);

  await c.eval(`(function(){var e=document.querySelector('.tcard .name, .ttable tbody tr .name');if(e)e.click();})()`);
  await waitFor("!!document.querySelector('.drawer')", 8000);
  await sleep(1700);
  await shot("b5_phone_detail");
  await c.eval(`(function(){var b=document.querySelector('.drawer-head .icon-btn');if(b)b.click();})()`);
  await sleep(600);

  await click(".mobile-only");
  await sleep(900);
  await shot("b6_phone_sidebar");
  await c.eval(`(function(){var m=document.querySelector('.mask');if(m)m.click();})()`);
  await sleep(600);

  await load(BASE + "/?view=settings&theme=light", "!!document.querySelector('.kv')", 2600);
  await c.eval(`window.scrollTo(0, document.querySelector('.content').scrollHeight)`);
  await sleep(900);
  await shot("b7_phone_settings_backup");

  await load(BASE + "/?view=torrents&theme=dark", "!!document.querySelector('.tcard')", 2600);
  await shot("b8_phone_torrents_dark");

  const overflow = await c.eval(`JSON.stringify({docW: document.documentElement.scrollWidth, winW: window.innerWidth})`);
  console.log("phone overflow check:", overflow);
  console.log("pageErrors:", errors.length ? errors : "none");

  c.ws.close();
  console.log("done");
  process.exit(0);
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
