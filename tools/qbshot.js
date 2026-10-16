/* Interactive verification: drive headless Edge over CDP, click real UI and
 * capture screenshots of every panel. Run with NODE_PATH pointing at the
 * workspace node_modules so `ws` resolves.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const PORT = 9333;
const OUT = "D:/Workspace WorkBuddy/qbpanel-fnos/_shots";
const BASE = "http://127.0.0.1:8898";

function httpJson(p) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port: PORT, path: p }, (r) => {
        let b = "";
        r.on("data", (c) => (b += c));
        r.on("end", () => resolve(JSON.parse(b)));
      })
      .on("error", reject);
  });
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
  }
  static async connect() {
    const list = await httpJson("/json/list");
    const page = list.find((t) => t.type === "page");
    if (!page) throw new Error("no page target");
    const ws = new WebSocket(page.webSocketDebuggerUrl, {
      perMessageDeflate: false,
      maxPayload: 256 * 1024 * 1024,
    });
    await new Promise((res, rej) => {
      ws.on("open", res);
      ws.on("error", rej);
    });
    const c = new CDP(ws);
    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.id && c.pending.has(msg.id)) {
        const { res, rej } = c.pending.get(msg.id);
        c.pending.delete(msg.id);
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
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          rej(new Error("timeout " + method));
        }
      }, 30000);
    });
  }
  async eval(expr) {
    const r = await this.send("Runtime.evaluate", {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
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
  await c.send("Emulation.setDeviceMetricsOverride", {
    width: 1680,
    height: 1050,
    deviceScaleFactor: 1,
    mobile: false,
  });

  async function shot(name) {
    const r = await c.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(OUT, name + ".png"), Buffer.from(r.data, "base64"));
    console.log("shot ->", name + ".png");
  }

  async function waitFor(expr, timeoutMs) {
    const ok = await c.eval(`new Promise(function(res){
      var t0=Date.now();
      var iv=setInterval(function(){
        var v=false;
        try { v = (${expr}); } catch(e) { v=false; }
        if (v) { clearInterval(iv); res(true); }
        else if (Date.now()-t0 > ${timeoutMs || 15000}) { clearInterval(iv); res(false); }
      }, 150);
    })`);
    return ok;
  }

  async function clickText(sel, text) {
    return c.eval(`(function(){
      var els = Array.prototype.slice.call(document.querySelectorAll(${JSON.stringify(sel)}));
      var el = els.filter(function(e){ return (e.textContent||"").trim().indexOf(${JSON.stringify(text)}) >= 0; })[0];
      if (!el) return false;
      el.click();
      return true;
    })()`);
  }

  /* --- 1. torrents list --- */
  await c.send("Page.navigate", { url: BASE + "/?view=torrents" });
  const ready = await waitFor("!!document.querySelector('.ttable tbody tr')", 20000);
  console.log("list ready:", ready);
  await sleep(1200);
  await shot("v1_torrents");

  /* --- 2. add modal --- */
  console.log("click 添加任务:", await clickText("button", "添加任务"));
  await sleep(700);
  await shot("v2_add_modal");
  await clickText("button", "取消");
  await sleep(400);

  /* --- 3. detail: general --- */
  const opened = await c.eval(`(function(){
    var el = document.querySelector('.ttable tbody tr .name');
    if (!el) return false; el.click(); return true;
  })()`);
  console.log("open detail:", opened);
  await waitFor("!!document.querySelector('.drawer')", 8000);
  await sleep(1600);
  await shot("v3_detail_general");

  /* --- 4. detail: files --- */
  await clickText(".tabs button", "文件");
  await sleep(1500);
  await shot("v4_detail_files");

  /* --- 5. detail: trackers --- */
  await clickText(".tabs button", "Tracker");
  await sleep(1500);
  await shot("v5_detail_trackers");

  /* --- 6. detail: peers --- */
  await clickText(".tabs button", "节点");
  await sleep(1500);
  await shot("v6_detail_peers");

  /* --- 7. close + stats --- */
  await c.eval(`(function(){ var b=document.querySelector('.drawer-head button'); if(b) b.click(); })()`);
  await sleep(400);
  await c.send("Page.navigate", { url: BASE + "/?view=stats" });
  await waitFor("!!document.querySelector('canvas')", 12000);
  await sleep(2600);
  await shot("v7_stats");

  /* --- 8. logs --- */
  await c.send("Page.navigate", { url: BASE + "/?view=logs" });
  await sleep(2600);
  await shot("v8_logs");

  /* --- 9. mobile viewport --- */
  await c.send("Emulation.setDeviceMetricsOverride", {
    width: 414,
    height: 860,
    deviceScaleFactor: 2,
    mobile: true,
  });
  await c.send("Page.navigate", { url: BASE + "/?view=dash" });
  await waitFor("!!document.querySelector('.stat')", 15000);
  await sleep(2200);
  await shot("v9_mobile_dash");

  await c.send("Page.navigate", { url: BASE + "/?view=torrents" });
  await waitFor("!!document.querySelector('.ttable tbody tr')", 15000);
  await sleep(1800);
  await shot("v10_mobile_torrents");

  c.ws.close();
  console.log("done");
  process.exit(0);
})().catch((e) => {
  console.error("FATAL", e.message);
  process.exit(1);
});
