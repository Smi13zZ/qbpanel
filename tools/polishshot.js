/* Verifies the 6 polish items.
 * Run: NODE_PATH=<workspace>/node_modules node tools/polishshot.js [baseUrl]
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
  async function load(url, ready) {
    await c.send("Page.navigate", { url });
    await waitFor(ready || "!!document.querySelector('.side-foot')", 20000);
    await sleep(2000);
  }

  console.log("\n--- 2) 主题反色 ---");
  await load(BASE + "/?view=dash&theme=light", "!!document.querySelector('.nav-item.on')");
  console.log("亮色 nav-active:", await c.eval(`getComputedStyle(document.documentElement).getPropertyValue('--nav-active').trim()`),
    "文字:", await c.eval(`getComputedStyle(document.querySelector('.nav-item.on')).color`));
  await shot("p1_light");
  await load(BASE + "/?view=dash&theme=dark", "!!document.querySelector('.nav-item.on')");
  console.log("暗色 nav-active:", await c.eval(`getComputedStyle(document.documentElement).getPropertyValue('--nav-active').trim()`),
    "文字:", await c.eval(`getComputedStyle(document.querySelector('.nav-item.on')).color`));
  await shot("p2_dark");

  console.log("\n--- 3) 勾选框对齐与间距 ---");
  await load(BASE + "/?view=settings&theme=dark", "!!document.querySelector('.switch')");
  const sw = await c.eval(`(function(){
    var lab=document.querySelector('.field > label.switch');
    var cb=lab.querySelector('input[type=checkbox]');
    var sp=lab.querySelector('span');
    var a=cb.getBoundingClientRect(), b=sp.getBoundingClientRect();
    return JSON.stringify({
      display: getComputedStyle(lab).display,
      gap: Math.round(b.left - a.right),
      cbMid: Math.round(a.top + a.height/2),
      txtMid: Math.round(b.top + b.height/2)
    });
  })()`);
  console.log("switch:", sw);
  await shot("p3_switch");

  console.log("\n--- 4) 点击遮罩不应关闭对话框 ---");
  await load(BASE + "/?view=servers&theme=light", "!!document.querySelector('.btn.primary')");
  await c.eval(`(function(){var b=document.querySelector('.btn.primary');if(b)b.click();})()`);
  await waitFor("!!document.querySelector('.modal')", 8000);
  await sleep(600);
  await c.eval(`(function(){
    var w=document.querySelector('.modal-wrap');
    var r=w.getBoundingClientRect();
    w.dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:r.left+5,clientY:r.top+5}));
  })()`);
  await sleep(700);
  console.log("点遮罩后对话框仍在:", await c.eval(`!!document.querySelector('.modal')`));
  const fp = await c.eval(`(function(){
    var f=document.querySelector('.modal .filepick');
    return f ? getComputedStyle(f.querySelector('input[type=file]')).position : 'no-filepick-in-this-modal';
  })()`);
  await shot("p4_modal");

  console.log("\n--- 5) 文件选择按钮已本地化（原生控件被隐藏）---");
  await load(BASE + "/?view=settings&lang=en&theme=light", "!!document.querySelector('.filepick')");
  console.log("文件选择:", await c.eval(`(function(){
    var fp=document.querySelector('.filepick');
    var inp=fp.querySelector('input[type=file]');
    var cs=getComputedStyle(inp);
    return JSON.stringify({ nativeHidden: cs.position==='absolute' && parseFloat(cs.width)<=2,
                            btn: fp.querySelector('.btn').textContent.trim(),
                            name: fp.querySelector('.filepick-name').textContent.trim() });
  })()`));
  await c.eval(`window.scrollTo(0, document.querySelector('.content').scrollHeight)`);
  await sleep(800);
  await shot("p5_filepick_en");

  console.log("\n--- 6) 危险按钮悬停不显示红框 ---");
  await load(BASE + "/?view=torrents&theme=dark", "!!document.querySelector('.ttable tbody tr .acts .btn.danger')");
  const box = JSON.parse(await c.eval(`(function(){
    var b=document.querySelector('.ttable tbody tr .acts .btn.danger');
    var r=b.getBoundingClientRect();
    return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)});
  })()`));
  await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y, button: "none" });
  await sleep(700);
  console.log("危险按钮悬停:", await c.eval(`(function(){
    var s=getComputedStyle(document.querySelector('.ttable tbody tr .acts .btn.danger'));
    return JSON.stringify({bg:s.backgroundColor, border:s.borderTopColor, color:s.color});
  })()`));
  await shot("p6_danger_hover");

  console.log("\n--- 1) 重复服务器 ---");
  console.log(await c.eval(`(async function(){
    var cfg = await (await fetch('./api/config')).json();
    var s = cfg.servers[0];
    var body = { name:'dup-test', kind:'qbittorrent', url:s.url, username:s.username, password:'x' };
    var r = await fetch('./api/servers', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)});
    return 'HTTP ' + r.status + ' ' + (await r.text()).slice(0,60);
  })()`));
  console.log("服务器数量未变:", await c.eval(`(async function(){
    var cfg = await (await fetch('./api/config')).json(); return cfg.servers.length;
  })()`));

  console.log("\npageErrors:", errors.length ? errors : "none");
  c.ws.close();
  console.log("done");
  process.exit(0);
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
