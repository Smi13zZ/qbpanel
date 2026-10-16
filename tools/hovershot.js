/* Verified hover feedback on the row action buttons + the add-server test path.
 * Run: NODE_PATH=<workspace>/node_modules node tools/hovershot.js [baseUrl]
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
  await c.send("Input.enable").catch(() => {});
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1500, height: 900, deviceScaleFactor: 1, mobile: false });

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
  function btnStyle() {
    return `(function(){
      var b = document.querySelector('.ttable tbody tr .acts .btn');
      if (!b) return null;
      var s = getComputedStyle(b);
      return JSON.stringify({ bg: s.backgroundColor, border: s.borderTopColor, color: s.color, opacity: s.opacity });
    })()`;
  }

  for (const theme of ["light", "dark"]) {
    await c.send("Page.navigate", { url: BASE + "/?view=torrents&theme=" + theme });
    await waitFor("!!document.querySelector('.ttable tbody tr .acts .btn')", 20000);
    await sleep(2200);

    const rest = await c.eval(btnStyle());
    const box = await c.eval(`(function(){
      var b = document.querySelector('.ttable tbody tr .acts .btn');
      var r = b.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) });
    })()`);
    const p = JSON.parse(box);
    await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y, button: "none" });
    await sleep(700);
    const hov = await c.eval(btnStyle());
    console.log(theme + " 静止:", rest);
    console.log(theme + " 悬停:", hov);
    await shot("h_" + theme + "_hover");
  }

  // add-server dialog: test an UNSAVED server straight from the form
  await c.send("Page.navigate", { url: BASE + "/?view=servers&theme=light" });
  await waitFor("!!document.querySelector('.btn.primary')", 20000);
  await sleep(1800);
  await c.eval(`(function(){var b=document.querySelector('.btn.primary');if(b)b.click();})()`);
  await waitFor("!!document.querySelector('.modal')", 8000);
  await sleep(600);
  await c.eval(`(function(){
    var i = document.querySelectorAll('.modal input.input');
    function set(el, v){ var d=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value'); d.set.call(el,v); el.dispatchEvent(new Event('input',{bubbles:true})); }
    set(i[0], 'mteam');
    set(i[1], '');
  })()`);
  await sleep(300);
  await shot("h_add_dialog");
  console.log("add dialog opened; pageErrors:", errors.length ? errors : "none");

  c.ws.close();
  console.log("done");
  process.exit(0);
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
