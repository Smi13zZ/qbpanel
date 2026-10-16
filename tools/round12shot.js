/* Round-12 checks:
 *   A. Android tap highlight is switched off
 *   B. saving a server probes it once automatically
 *   C. per-torrent limit modal has the kB/s | MB/s picker
 *
 * B adds a deliberately unreachable server, then deletes it again.
 * C really applies a 100 MB/s limit to the first torrent, then restores 0.
 *
 * Run: NODE_PATH=<workspace>/node_modules node tools/round12shot.js [baseUrl]
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const PORT = 9333;
const OUT = "D:/Workspace WorkBuddy/qbpanel-fnos/_shots";
const BASE = process.argv[2] || "http://127.0.0.1:8898";
const TEST_URL = "http://127.0.0.1:9";
const TEST_NAME = "zz-auto-probe";

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
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + " " + JSON.stringify(r.exceptionDetails.exception || {}).slice(0, 160));
    return r.result.value;
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SETVAL = `window.__set = function(el, v, ev){
  var d = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value');
  d.set.call(el, v);
  el.dispatchEvent(new Event(ev, { bubbles: true }));
};`;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const c = await CDP.connect();
  await c.send("Page.enable");
  await c.send("Runtime.enable");
  await c.send("Network.enable");
  await c.send("Network.setCacheDisabled", { cacheDisabled: true });
  // no viewport emulation on purpose - see HANDOFF (stale composited layers)
  await c.send("Emulation.clearDeviceMetricsOverride");

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
  function qbExpr(p, init) {
    return `(async function(){
      try {
        var r = await fetch('./api/qb/${p}', ${init || "{}"});
        var t = await r.text();
        try { return JSON.stringify({ status: r.status, data: JSON.parse(t) }); }
        catch (e) { return JSON.stringify({ status: r.status, text: String(t).slice(0, 200) }); }
      } catch (e) { return JSON.stringify({ error: String(e && e.message || e) }); }
    })()`;
  }
  async function qbApi(p, init) {
    const raw = await c.eval(qbExpr(p, init));
    return JSON.parse(raw);
  }
  async function panel(pathname) {
    const raw = await c.eval(`fetch('./api${pathname}').then(function(r){return r.text();}).then(function(t){try{return JSON.stringify({data:JSON.parse(t)});}catch(e){return JSON.stringify({text:String(t).slice(0,200)});}})`);
    return JSON.parse(raw);
  }

  /* ---------------- A. tap highlight ---------------- */
  console.log("== A. Android tap highlight ==");
  await c.send("Page.navigate", { url: BASE + "/?view=dash&theme=dark&lang=zh" });
  await waitFor("!!document.querySelector('.nav-item')", 25000);
  await sleep(1500);
  console.log("  " + await c.eval(`(function(){
    function g(el){ return el ? getComputedStyle(el).getPropertyValue('-webkit-tap-highlight-color') : null; }
    return JSON.stringify({
      body: g(document.body),
      btn: g(document.querySelector('.btn')),
      nav: g(document.querySelector('.nav-item')),
      checkbox: g(document.querySelector('input[type=checkbox]'))
    });
  })()`));

  /* ---------------- B. saving a server probes it ---------------- */
  console.log("== B. new server is probed once on save ==");
  await c.send("Page.navigate", { url: BASE + "/?view=servers&theme=dark&lang=zh" });
  await waitFor("!!document.querySelector('.grid.c2 .card')", 25000);
  await sleep(2000);
  const before = await panel("/config");
  const beforeCount = (before.data && before.data.servers || []).length;
  console.log("  servers before:", beforeCount);

  await c.eval(`document.querySelector('.toolbar .btn.primary').click()`);
  await waitFor("!!document.querySelector('.modal .input')", 8000);
  await sleep(400);
  await c.eval(SETVAL);
  await c.eval(`(function(){
    var m = document.querySelector('.modal');
    var inputs = [].slice.call(m.querySelectorAll('input.input'));
    window.__set(inputs[0], ${JSON.stringify(TEST_NAME)}, 'input');
    window.__set(inputs[1], ${JSON.stringify(TEST_URL)}, 'input');
    return inputs.length;
  })()`);
  await shot("r12_server_form.png");
  await c.eval(`document.querySelector('.modal-foot .btn.primary').click()`);

  // the chip should pass through "testing" - that is the automatic probe
  await sleep(450);
  const midFont = `(function(){
    var cards = [].slice.call(document.querySelectorAll('.grid.c2 .card'));
    var el = cards.filter(function(c){ var u=c.querySelector('.mono.dim'); return u && u.textContent.trim() === ${JSON.stringify(TEST_URL)}; })[0];
    if (!el) return JSON.stringify({found:false});
    var dot = el.querySelector('.chip .dot');
    return JSON.stringify({ found:true, dotClass: dot ? dot.className : null,
      chip: dot ? dot.parentElement.textContent.trim() : null });
  })()`;
  console.log("  ~0.5s after save:", await c.eval(midFont));
  await sleep(5000);
  console.log("  ~5.5s after save:", await c.eval(midFont));
  console.log("  toasts:", await c.eval(`JSON.stringify([].slice.call(document.querySelectorAll('.toast')).map(function(t){return t.textContent.trim();}))`));
  const after = await panel("/config");
  const afterCount = (after.data && after.data.servers || []).length;
  console.log("  servers after:", afterCount, afterCount === beforeCount + 1 ? "OK" : "MISMATCH");
  await shot("r12_server_added.png");

  const newId = (after.data.servers.filter((s) => s.url === TEST_URL)[0] || {}).id;
  if (newId) {
    const del = await c.eval(`fetch('./api/servers/' + encodeURIComponent(${JSON.stringify(newId)}), { method: 'DELETE' })
      .then(function(r){return r.status;})`);
    await sleep(900);
    const back = await panel("/config");
    const backCount = (back.data.servers || []).length;
    console.log("  cleanup delete ->", del, "| servers now:", backCount, backCount === beforeCount ? "OK" : "FAILED");
  } else {
    console.log("  cleanup: could not find the test server id!");
  }

  /* ---------------- C. per-torrent limit units ---------------- */
  console.log("== C. torrent limit modal units ==");
  await c.send("Page.navigate", { url: BASE + "/?view=torrents&theme=dark&lang=zh" });
  await waitFor("!!document.querySelector('.ttable.tlist tbody tr, .tcard')", 25000);
  await sleep(2500);
  await c.eval(SETVAL);

  await c.eval(`document.querySelector('.ttable tbody tr input[type=checkbox]').click()`);
  await waitFor("!!document.querySelector('.toolbar .btn.sm.danger')", 8000);
  await sleep(500);
  // 4th .btn.sm in the bulk bar is the limit button (pause/resume/recheck/limit)
  const opened = await c.eval(`(function(){
    var btns = [].slice.call(document.querySelectorAll('.toolbar .btn.sm'));
    if (!btns[3]) return 'no-button:' + btns.length;
    btns[3].click();
    return btns[3].textContent.trim();
  })()`);
  console.log("  opened modal via:", opened);
  await waitFor("!!document.querySelector('.modal .field .select')", 8000);
  await sleep(600);
  console.log("  " + await c.eval(`(function(){
    var m = document.querySelector('.modal');
    var sels = [].slice.call(m.querySelectorAll('.field .select'));
    return JSON.stringify({
      unitSelects: sels.length,
      opts: sels.map(function(s){ return [].slice.call(s.options).map(function(o){return o.value;}).join('|'); }),
      labels: [].slice.call(m.querySelectorAll('.field > label')).map(function(l){return l.textContent.trim();}),
      title: m.querySelector('.modal-head').textContent.trim()
    });
  })()`));
  await shot("r12_limit_modal.png");

  const hash = await c.eval(`document.querySelector('.ttable tbody tr input[type=checkbox]').value`);
  const infoBefore = await qbApi("api/v2/torrents/info?hashes=" + hash);
  const origDl = (infoBefore.data && infoBefore.data[0] && Number(infoBefore.data[0].dl_limit)) || 0;
  console.log("  torrent", String(hash).slice(0, 8), "dl_limit before:", origDl);

  await c.eval(`(function(){
    var m = document.querySelector('.modal');
    var f = m.querySelectorAll('.field')[0];                 // 0 = download
    window.__set(f.querySelector('input'), '100', 'input');
    window.__set(f.querySelector('select'), 'MB', 'change');
    return 1;
  })()`);
  await c.eval(`document.querySelector('.modal-foot .btn.primary').click()`);
  await sleep(2500);
  const infoAfter = await qbApi("api/v2/torrents/info?hashes=" + hash);
  const gotDl = (infoAfter.data && infoAfter.data[0] && Number(infoAfter.data[0].dl_limit)) || 0;
  console.log("  dl_limit after apply:", gotDl, gotDl === 104857600 ? "OK" : "MISMATCH (expected 104857600)");

  const restored = await c.eval(`fetch('./api/qb/api/v2/torrents/setDownloadLimit', {
      method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'},
      body:'hashes=' + encodeURIComponent(${JSON.stringify(hash)}) + '&limit=' + ${origDl}
    }).then(function(r){return r.status;})`);
  await sleep(1200);
  const infoBack = await qbApi("api/v2/torrents/info?hashes=" + hash);
  const nowDl = (infoBack.data && infoBack.data[0] && Number(infoBack.data[0].dl_limit)) || 0;
  console.log("  restore ->", restored, "| dl_limit now:", nowDl, nowDl === origDl ? "OK" : "FAILED");

  console.log("pageErrors:", errors.length ? errors : "none");
  c.ws.close();
  console.log("done");
  process.exit(0);
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
