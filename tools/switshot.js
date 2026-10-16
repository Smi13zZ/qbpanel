/* Verifies: topbar server switch reloads, servers page auto-tests, donut caption gone.
 * Run: NODE_PATH=<workspace>/node_modules node tools/switshot.js [baseUrl]
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
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 950, deviceScaleFactor: 1, mobile: false });

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
  const maindataHits = `performance.getEntriesByType('resource').filter(function(r){return r.name.indexOf('/api/qb/api/v2/sync/maindata')>=0}).length`;

  /* ---------- 1) topbar switch reloads ---------- */
  console.log("--- 1) 顶栏切换服务器 ---");
  await c.send("Page.navigate", { url: BASE + "/?view=dash" });
  await waitFor("!!document.querySelector('.topbar select')", 20000);
  await sleep(2500);
  const before = await c.eval(`(async function(){
    var cfg = await (await fetch('./api/config')).json();
    var sel = document.querySelector('.topbar select');
    return JSON.stringify({ current: cfg.current, options: cfg.servers.map(function(s){return s.id}),
                            selectValue: sel.value, hits: ${maindataHits} });
  })()`);
  console.log("切换前:", before);
  const b = JSON.parse(before);
  const target = b.options.filter((x) => x !== b.current)[0];
  if (!target) {
    console.log("只有一个服务器，跳过切换测试");
  } else {
    await c.eval(`(function(){
      var sel = document.querySelector('.topbar select');
      sel.value = ${JSON.stringify(target)};
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await sleep(4000);
    const after = await c.eval(`(async function(){
      var cfg = await (await fetch('./api/config')).json();
      return JSON.stringify({ current: cfg.current, selectValue: document.querySelector('.topbar select').value,
                              hits: ${maindataHits}, torrents: (window.__vm && 0) });
    })()`);
    console.log("切换后:", after);
    const a = JSON.parse(after);
    console.log("  current 已变:", a.current === target ? "OK" : "FAIL(" + a.current + "!=" + target + ")");
    console.log("  又拉了一次数据:", a.hits > b.hits ? "OK (" + b.hits + " -> " + a.hits + ")" : "FAIL");
    // switch back
    await c.eval(`(function(){
      var sel = document.querySelector('.topbar select');
      sel.value = ${JSON.stringify(b.current)};
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await sleep(3500);
  }
  await shot("s1_after_switch");

  /* ---------- 2) servers page auto test ---------- */
  console.log("\n--- 2) 进入服务器页自动测试 ---");
  await c.send("Page.navigate", { url: BASE + "/?view=dash" });
  await waitFor("!!document.querySelector('.nav-item')", 20000);
  await sleep(2200);
  await c.eval(`(function(){
    var items=[].slice.call(document.querySelectorAll('.nav-item'));
    var b=items.filter(function(x){return x.textContent.indexOf('服务器')>=0||x.textContent.toLowerCase().indexOf('server')>=0})[0];
    if(b)b.click();
  })()`);
  await sleep(700);
  const early = await c.eval(`[].slice.call(document.querySelectorAll('.grid.c2 > .card .chip')).map(function(x){return x.textContent.trim()}).join(' | ')`);
  console.log("刚进入时状态:", early);
  await sleep(9000);
  const late = await c.eval(`[].slice.call(document.querySelectorAll('.grid.c2 > .card .chip')).map(function(x){return x.textContent.trim()}).join(' | ')`);
  console.log("测试完成后:", late);
  console.log("  已自动测试:", /未检测|unknown/.test(late) ? "仍有未检测(部分失败?)" : "OK 全部有结果");
  await shot("s2_servers_autotest");

  /* ---------- 3) donut caption ---------- */
  console.log("\n--- 3) 环形图无“个任务” ---");
  await c.send("Page.navigate", { url: BASE + "/?view=dash" });
  await waitFor("!!document.querySelector('canvas')", 20000);
  await sleep(2600);
  const box = JSON.parse(await c.eval(`(function(){
    var cv=document.querySelector('.grid.c2 .card canvas');
    var r=cv.getBoundingClientRect();
    return JSON.stringify({x:Math.round(r.left),y:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height)});
  })()`));
  const r = await c.send("Page.captureScreenshot", {
    format: "png",
    clip: { x: box.x, y: box.y, width: box.w, height: box.h, scale: 2 },
  });
  fs.writeFileSync(path.join(OUT, "s3_donut.png"), Buffer.from(r.data, "base64"));
  console.log("shot -> s3_donut (裁剪 " + box.w + "x" + box.h + ")");

  console.log("\npageErrors:", errors.length ? errors : "none");
  c.ws.close();
  console.log("done");
  process.exit(0);
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
