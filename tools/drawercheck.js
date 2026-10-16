/* Mobile drawer verification: hit-testing, clickability and footer centering.
 * Run: NODE_PATH=<workspace>/node_modules node tools/drawercheck.js [baseUrl]
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
  await c.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });

  const errors = [];
  c.ws.on("message", (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.method === "Runtime.exceptionThrown") errors.push(JSON.stringify(m.params.exceptionDetails).slice(0, 200));
  });

  async function shot(name) {
    const r = await c.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(OUT, name + ".png"), Buffer.from(r.data, "base64"));
    console.log("shot ->", name);
  }
  async function waitFor(expr, ms) {
    return c.eval(`new Promise(function(res){var t0=Date.now();var iv=setInterval(function(){var v=false;try{v=(${expr});}catch(e){v=false;}if(v){clearInterval(iv);res(true);}else if(Date.now()-t0>${ms || 15000}){clearInterval(iv);res(false);}},150);})`);
  }

  await c.send("Page.navigate", { url: BASE + "/?view=torrents&theme=light" });
  await waitFor("!!document.querySelector('.tcard')", 20000);
  await sleep(2000);

  // open the drawer
  await c.eval(`(function(){var e=document.querySelector('.mobile-only');if(e)e.click();})()`);
  await sleep(1000);
  await shot("d1_drawer_open");

  // 1. what element is on top at the sidebar centre?
  const hit = await c.eval(`(function(){
    var side=document.querySelector('.side').getBoundingClientRect();
    var cx=Math.round(side.left+side.width/2), cy=Math.round(side.top+side.height*0.35);
    var el=document.elementFromPoint(cx, cy);
    return JSON.stringify({ x:cx, y:cy, tag: el ? el.tagName : null,
      cls: el ? el.className : null, inSidebar: !!(el && el.closest('.side')) });
  })()`);
  console.log("hit-test at drawer centre:", hit);

  // 2. centering of the theme + language buttons
  const center = await c.eval(`(function(){
    var side=document.querySelector('.side').getBoundingClientRect();
    var row=document.querySelector('.foot-row').getBoundingClientRect();
    var ver=document.querySelector('.ver-line').getBoundingClientRect();
    return JSON.stringify({
      sideMid: Math.round(side.left+side.width/2),
      rowMid: Math.round(row.left+row.width/2),
      verMid: Math.round(ver.left+ver.width/2)
    });
  })()`);
  console.log("centring:", center);

  // 3. actually click the theme button inside the drawer and walk the cycle
  const seq = [];
  for (let i = 0; i < 3; i++) {
    const title = await c.eval(`document.querySelector('.foot-row .icon-btn').title`);
    const dt = await c.eval(`document.documentElement.getAttribute('data-theme')`);
    seq.push(title + " [" + dt + "]");
    await c.eval(`(function(){var b=document.querySelectorAll('.foot-row .icon-btn');if(b[0])b[0].click();})()`);
    await sleep(1100);
  }
  const after = await c.eval(`document.documentElement.getAttribute('data-theme')`);
  console.log("theme cycle:", seq.join("  ->  "), " final data-theme:", after);

  // 4. click a nav item
  const viewBefore = await c.eval(`(document.querySelector('.nav-item.on')||{}).textContent`);
  await c.eval(`(function(){var n=document.querySelectorAll('.nav-item');if(n[3])n[3].click();})()`);
  await sleep(1200);
  const viewAfter = await c.eval(`(document.querySelector('.nav-item.on')||{}).textContent`);
  const drawerClosed = await c.eval(`!document.querySelector('.side').classList.contains('open')`);
  console.log("nav click:", JSON.stringify(viewBefore && viewBefore.trim()), "->", JSON.stringify(viewAfter && viewAfter.trim()), "| drawer closed:", drawerClosed);

  await shot("d2_after_nav_click");

  // 5. language button
  await c.eval(`(function(){var e=document.querySelector('.mobile-only');if(e)e.click();})()`);
  await sleep(800);
  const txtBefore = await c.eval(`document.querySelector('.nav-item .label').textContent.trim()`);
  const attrBefore = await c.eval(`document.documentElement.getAttribute('lang')`);
  await c.eval(`(function(){var b=document.querySelectorAll('.foot-row .icon-btn');if(b[1])b[1].click();})()`);
  await sleep(1300);
  const txtAfter = await c.eval(`document.querySelector('.nav-item .label').textContent.trim()`);
  const attrAfter = await c.eval(`document.documentElement.getAttribute('lang')`);
  console.log("language button click:", txtBefore + "/" + attrBefore, "->", txtAfter + "/" + attrAfter,
    txtBefore !== txtAfter ? "OK" : "NOT WORKING");
  await shot("d3_drawer_lang");

  console.log("pageErrors:", errors.length ? errors : "none");
  c.ws.close();
  console.log("done");
  process.exit(0);
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
