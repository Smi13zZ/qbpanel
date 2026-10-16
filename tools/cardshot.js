/* Round-10 checks: charts after a view switch, phone card title clamping,
 * phone long-press selection. Run:
 *   NODE_PATH=<workspace>/node_modules node tools/cardshot.js [baseUrl]
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

/* canvas ink = how many non-transparent pixels the 2d context actually holds.
   A canvas that was never drawn keeps the default 300x150 bitmap and zero ink. */
const CANVAS_PROBE = `(function(){
  window.__cvSeen = window.__cvSeen || new WeakMap();
  window.__cvSeq = window.__cvSeq || 0;
  var cv = document.querySelector('.chart-box canvas');
  if(!cv) return JSON.stringify({found:false});
  if(!window.__cvSeen.has(cv)) window.__cvSeen.set(cv, ++window.__cvSeq);
  var r = cv.getBoundingClientRect();
  var ink = -1;
  try {
    var d = cv.getContext('2d').getImageData(0,0,cv.width,cv.height).data;
    ink = 0;
    for (var i=3;i<d.length;i+=4) if (d[i]>0) ink++;
  } catch(e) { ink = 'err:' + e.message; }
  return JSON.stringify({found:true, id:window.__cvSeen.get(cv),
    propW:cv.width, propH:cv.height,
    cssW:Math.round(r.width), cssH:Math.round(r.height), ink:ink});
})()`;

function navClick(i) {
  return `(function(){
    var n = document.querySelectorAll('.nav-item');
    if(!n[${i}]) return 'no-nav:' + n.length;
    n[${i}].click();
    return n[${i}].textContent.trim();
  })()`;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const c = await CDP.connect();
  await c.send("Page.enable");
  await c.send("Runtime.enable");
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
  async function shot(name) {
    const s = await c.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(OUT, name), Buffer.from(s.data, "base64"));
  }

  /* ================= A. chart survives a view switch (desktop) ============ */
  console.log("== A. speed charts after switching views ==");
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false });
  await c.send("Page.navigate", { url: BASE + "/?view=dash&theme=dark" });
  const ready = await waitFor("!!document.querySelector('.chart-box canvas')", 25000);
  await sleep(3000);                                  // let the sparkline collect points
  console.log("  canvas present:", ready);
  console.log("  dash  #1 (first paint)   ", await c.eval(CANVAS_PROBE));
  await shot("r10_dash_first.png");

  // leave the page and come back: the canvas element is rebuilt meanwhile
  console.log("  click nav[1] ->", await c.eval(navClick(1)));
  await waitFor("!!document.querySelector('.ttable.tlist tbody tr, .tcard')", 15000);
  await sleep(1500);
  console.log("  click nav[0] ->", await c.eval(navClick(0)));
  await waitFor("!!document.querySelector('.chart-box canvas')", 15000);
  await sleep(2000);
  console.log("  dash  #3 (back from list)", await c.eval(CANVAS_PROBE));
  await shot("r10_dash_back.png");

  console.log("== A2. stats chart after switching views ==");
  await c.eval(navClick(3));
  await waitFor("!!document.querySelector('.chart-box canvas')", 15000);
  await sleep(2500);
  console.log("  stats #1 (first paint)   ", await c.eval(CANVAS_PROBE));
  await c.eval(navClick(0));
  await sleep(900);
  await c.eval(navClick(3));
  await waitFor("!!document.querySelector('.chart-box canvas')", 15000);
  await sleep(2500);
  console.log("  stats #2 (back from dash)", await c.eval(CANVAS_PROBE));
  await shot("r10_stats_back.png");

  /* ================= B. phone card title + long-press ==================== */
  console.log("== B. phone: card title clamps to one line ==");
  await c.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await c.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await c.send("Page.navigate", { url: BASE + "/?view=torrents&theme=dark" });
  await waitFor("!!document.querySelector('.tcard')", 25000);
  await sleep(2500);

  const titleProbe = `(function(){
    var names = [].slice.call(document.querySelectorAll('.tcard .tname'));
    if(!names.length) return JSON.stringify({found:false});
    var stats = names.map(function(el){
      var cs = getComputedStyle(el), r = el.getBoundingClientRect();
      return { h:Math.round(r.height), w:Math.round(r.width),
               sw: el.scrollWidth, cw: el.clientWidth,
               ws: cs.whiteSpace, ov: cs.overflow, to: cs.textOverflow,
               us: cs.userSelect || cs.webkitUserSelect };
    });
    stats.sort(function(a,b){ return b.sw - a.sw; });
    var longest = stats[0];
    return JSON.stringify({
      count: names.length,
      longest: longest,
      longestOverflows: longest.sw > longest.cw,
      allSingleLine: stats.every(function(s){ return s.h <= 26; }),
      heights: stats.slice(0,6).map(function(s){ return s.h; })
    });
  })()`;
  console.log("  " + await c.eval(titleProbe));
  console.log("  body/input user-select: " + await c.eval(`(function(){
    function us(el){ if(!el) return null; var cs=getComputedStyle(el); return cs.userSelect || cs.webkitUserSelect || '(none)'; }
    return JSON.stringify({ body: us(document.body),
      title: us(document.querySelector('.tcard .tname')),
      input: us(document.querySelector('.toolbar input.input') || document.querySelector('input')),
      textarea: us(document.querySelector('textarea')),
      callout: getComputedStyle(document.body).webkitTouchCallout || '(unset)' });
  })()`));
  await shot("r10_phone_torrents.png");

  // The local qB only holds short names - a short fixture would hide a width bug
  // outright (that is exactly how the 710px name column slipped through in
  // 26.10.8). Inject a realistic release name and measure the real layout.
  const LONG = "[伪钞重案].The.Great.Money.Robbery.2026.2.1080p.HQ.WEB-DL.H265.10bit.HDR.DoVi.DDP5.1-CMCTV";
  const longProbe = await c.eval(`(function(){
    var el = document.querySelector('.tcard .tname');
    if(!el) return JSON.stringify({found:false});
    el.textContent = ${JSON.stringify(LONG)};
    void el.offsetWidth;
    var cs = getComputedStyle(el), r = el.getBoundingClientRect();
    var card = el.closest('.tcard').getBoundingClientRect();
    var doc = document.documentElement;
    return JSON.stringify({
      titleH: Math.round(r.height), titleW: Math.round(r.width),
      sw: el.scrollWidth, cw: el.clientWidth,
      ws: cs.whiteSpace, ov: cs.overflow, to: cs.textOverflow,
      singleLine: r.height <= 26,
      cardW: Math.round(card.width), cardH: Math.round(card.height),
      pageOverflowX: doc.scrollWidth - doc.clientWidth
    });
  })()`);
  console.log("  long-name injected: " + longProbe);
  await shot("r10_phone_longname.png");
  console.log("  longest title:", LONG.slice(0, 80));

  console.log("pageErrors:", errors.length ? errors : "none");
  c.ws.close();
  console.log("done");
  process.exit(0);
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
