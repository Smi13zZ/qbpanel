/* End-to-end: add-server dialog -> 测试连接 WITHOUT saving first.
 * Run: NODE_PATH=<workspace>/node_modules node tools/testconn.js [baseUrl]
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const PORT = 9333;
const OUT = "D:/Workspace WorkBuddy/qbpanel-fnos/_shots";
const BASE = process.argv[2] || "http://127.0.0.1:8898";
const CFG = "D:/Workspace WorkBuddy/qbpanel-fnos/_local/var/config.json";

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

const fill = (el, v) => `(function(){
  var d = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
  d.set.call(${el}, ${JSON.stringify(v)});
  ${el}.dispatchEvent(new Event('input', { bubbles: true }));
})()`;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const srvCfg = JSON.parse(fs.readFileSync(CFG, "utf8")).servers[0];

  const c = await CDP.connect();
  await c.send("Page.enable");
  await c.send("Runtime.enable");
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

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

  await c.send("Page.navigate", { url: BASE + "/?view=servers&theme=light" });
  await waitFor("!!document.querySelector('.btn.primary')", 20000);
  await sleep(2000);

  // count servers before
  const before = await c.eval(`document.querySelectorAll('.grid.c2 > .card').length`);
  console.log("已有服务器数:", before);

  await c.eval(`(function(){var b=document.querySelector('.btn.primary');if(b)b.click();})()`);
  await waitFor("!!document.querySelector('.modal')", 8000);
  await sleep(500);

  // name / url / username / password inputs inside the dialog
  await c.eval(fill(`document.querySelectorAll('.modal input.input')[0]`, "mteam"));
  await c.eval(fill(`document.querySelectorAll('.modal input.input')[1]`, srvCfg.url));
  await c.eval(fill(`document.querySelectorAll('.modal input.input')[2]`, srvCfg.username));
  await c.eval(fill(`document.querySelectorAll('.modal input.input')[3]`, srvCfg.password));
  await sleep(400);
  await shot("t1_dialog_filled");

  // click 测试连接 (first footer button - label differs per language)
  await c.eval(`(function(){
    var b = document.querySelectorAll('.modal-foot .btn')[0];
    if (b) b.click();
  })()`);
  await sleep(4500);

  const msg = await c.eval(`(function(){var h=document.querySelector('.modal .test-msg');return h?h.textContent.trim():null;})()`);
  console.log("对话框提示:", JSON.stringify(msg));
  await shot("t2_dialog_tested");

  const stillOpen = await c.eval(`!!document.querySelector('.modal')`);
  console.log("对话框仍打开(未保存):", stillOpen);

  // now save (last footer button) and confirm it persists
  await c.eval(`(function(){
    var bs = document.querySelectorAll('.modal-foot .btn');
    var b = bs[bs.length - 1];
    if (b) b.click();
  })()`);
  await sleep(3000);
  const now = await c.eval(`document.querySelectorAll('.grid.c2 > .card').length`);
  console.log("保存后服务器数:", now, now > before ? "OK 已新增" : "未新增");

  console.log("pageErrors:", errors.length ? errors : "none");
  c.ws.close();
  console.log("done");
  process.exit(0);
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
