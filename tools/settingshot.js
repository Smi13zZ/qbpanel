/* Round-11 checks: localised connection status, alternative-speed-limit removal,
 * global limit unit picker (kB/s | MB/s).
 *
 * The unit test writes a real global limit to the connected qBittorrent, so the
 * original byte value is read first and restored at the end.
 *
 * Run: NODE_PATH=<workspace>/node_modules node tools/settingshot.js [baseUrl]
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

/* native setter + bubbling event - setting .value on a Vue-bound input does
   nothing on its own, the framework only sees dispatched events */
const SETVAL = `window.__set = function(el, v, ev){
  var d = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value');
  d.set.call(el, v);
  el.dispatchEvent(new Event(ev, { bubbles: true }));
};`;

const FIELD_PROBE = `(function(){
  var card = null;
  [].slice.call(document.querySelectorAll('.card')).forEach(function(c){
    var h = c.querySelector('h3');
    if (h && /限速|limit/i.test(h.parentNode.textContent) && c.querySelector('.field .select')) card = c;
  });
  if (!card) return JSON.stringify({found:false});
  var fields = [].slice.call(card.querySelectorAll('.field'));
  var out = fields.map(function(f){
    var inp = f.querySelector('input'), sel = f.querySelector('.field .select, select');
    var lab = f.querySelector('label');
    return {
      label: lab ? lab.textContent.trim() : null,
      inputType: inp ? inp.type : null,
      inputValue: inp ? inp.value : null,
      unit: sel ? sel.value : null,
      unitOpts: sel ? [].slice.call(sel.options).map(function(o){return o.value;}).join('|') : null,
      unitFlex: sel ? getComputedStyle(sel).flexBasis : null,
      hint: f.querySelector('.hint') ? f.querySelector('.hint').textContent.trim() : null,
      hasBtn: !!f.querySelector('.btn')
    };
  });
  return JSON.stringify({
    found: true,
    fields: out,
    altGone: !/备用速度限制模式|Alternative speed/i.test(document.body.textContent),
    selectCount: card.querySelectorAll('.field select').length
  });
})()`;

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
  /* Deliberately no setDeviceMetricsOverride in this script: after an emulated
     viewport change headless Edge keeps stale composited layers around
     (getComputedStyle reports the dark tokens while the capture still shows the
     previous light paint - the sidebar layer was the last to catch up). The
     default window size gives correct captures, so just make sure no override
     is left over from an earlier session. */
  async function shot(name) {
    const s = await c.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(OUT, name), Buffer.from(s.data, "base64"));
  }
  /* fetch through the panel's own proxy so the test uses the same credentials
     the UI does; returned as a JSON envelope so failures stay readable */
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
  async function qbGet(p) {
    const raw = await c.eval(qbExpr(p));
    let env; try { env = JSON.parse(raw); } catch (e) { throw new Error("bad envelope: " + raw); }
    if (env.error) throw new Error("fetch failed: " + env.error);
    return env;
  }

  await c.send("Emulation.clearDeviceMetricsOverride");

  /* ---------- A. connection status is localised ---------- */
  console.log("== A. connection status wording ==");
  for (const [lang, view, probe, want] of [
    ["zh", "dash", `(document.querySelectorAll('.grid.c4 .stat')[3]||{querySelector:function(){return null}}).querySelector('.s').textContent.trim()`, "中文"],
    ["zh", "stats", `(document.querySelectorAll('.grid.c3 .stat')[2]||{querySelector:function(){return null}}).querySelector('.s').textContent.trim()`, "中文"],
    ["zh", "settings", `document.querySelectorAll('.kv dd')[1].textContent.trim()`, "中文"],
    ["en", "dash", `(document.querySelectorAll('.grid.c4 .stat')[3]||{querySelector:function(){return null}}).querySelector('.s').textContent.trim()`, "英文"],
  ]) {
    await c.send("Page.navigate", { url: BASE + "/?view=" + view + "&theme=dark&lang=" + lang });
    await waitFor("!!document.querySelector('.stat .s, .kv dd')", 25000);
    await sleep(1800);
    let txt = "";
    try { txt = await c.eval(probe); } catch (e) { txt = "PROBE-ERR " + e.message; }
    const stillEnglish = /\b(connected|firewalled|disconnected|connecting)\b/i.test(txt);
    console.log(`  [${lang}] ${view.padEnd(9)} -> "${txt}"  (${want}, raw-token=${stillEnglish})`);
  }

  /* ---------- B. settings card structure ---------- */
  console.log("== B. settings: alt-speed removed, unit pickers present ==");
  await c.send("Page.navigate", { url: BASE + "/?view=settings&theme=dark&lang=zh" });
  await waitFor("!!document.querySelector('.kv dd')", 25000);
  await sleep(2500);
  const struct = JSON.parse(await c.eval(FIELD_PROBE));
  console.log("  alt-speed removed:", struct.altGone, "| unit selects:", struct.selectCount);
  (struct.fields || []).forEach((f) => console.log("   ·", JSON.stringify(f)));
  await shot("r11_settings_units.png");

  // a navigation wipes window - the value setter helper has to be re-injected
  await c.eval(SETVAL);

  /* ---------- C. the unit picker actually drives the limit ---------- */
  console.log("== C. kB/s vs MB/s applies the right byte value ==");
  const before = await qbGet("api/v2/app/preferences");
  const origDl = Number(before.data && before.data.dl_limit) || 0;
  console.log("  qB dl_limit before:", origDl, "bytes");

  const apply = `(function(){
    var card = null;
    [].slice.call(document.querySelectorAll('.card')).forEach(function(c){
      if (c.querySelector('.field .select')) card = c;
    });
    var f = card.querySelectorAll('.field')[0];              // 0 = download limit
    var inp = f.querySelector('input'), sel = f.querySelector('select');
    window.__set(inp, '100', 'input');
    window.__set(sel, 'MB', 'change');
    return JSON.stringify({ typed: inp.value, unit: sel.value, shown: inp.value });
  })()`;
  console.log("  type 100 + pick MB/s ->", await c.eval(apply));
  // switching units must NOT rewrite the number the user typed
  const switchBack = await c.eval(`(function(){
    var card = null;
    [].slice.call(document.querySelectorAll('.card')).forEach(function(c){
      if (c.querySelector('.field .select')) card = c;
    });
    var f = card.querySelectorAll('.field')[0];
    var inp = f.querySelector('input'), sel = f.querySelector('select');
    window.__set(sel, 'kB', 'change');
    var afterKb = inp.value;
    window.__set(sel, 'MB', 'change');
    return JSON.stringify({ keptAfterKb: afterKb, keptAfterMb: inp.value });
  })()`);
  console.log("  unit toggle keeps the typed number:", switchBack);

  await c.eval(`(function(){
    var card = null;
    [].slice.call(document.querySelectorAll('.card')).forEach(function(c){
      if (c.querySelector('.field .select')) card = c;
    });
    card.querySelectorAll('.field')[0].querySelector('.btn').click();
  })()`);
  await sleep(2500);
  const after = await qbGet("api/v2/app/preferences");
  const gotDl = Number(after.data && after.data.dl_limit) || 0;
  console.log("  qB dl_limit after:", gotDl, "bytes  (expected 104857600 =", 100 * 1024 * 1024, ")",
    gotDl === 104857600 ? "OK" : "MISMATCH");
  const hint = await c.eval(`(function(){
    var card = null;
    [].slice.call(document.querySelectorAll('.card')).forEach(function(c){
      if (c.querySelector('.field .select')) card = c;
    });
    var f = card.querySelectorAll('.field')[0];
    return JSON.stringify({ input: f.querySelector('input').value, unit: f.querySelector('select').value,
      hint: f.querySelector('.hint').textContent.trim() });
  })()`);
  console.log("  UI after apply:", hint);
  await shot("r11_settings_applied.png");

  // restore - never leave a stray limit on the user's downloader
  const restored = await c.eval(`fetch('./api/qb/api/v2/app/setPreferences', {
      method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'},
      body:'json=' + encodeURIComponent(JSON.stringify({ dl_limit: ${origDl} }))
    }).then(function(r){return r.status;})`);
  await sleep(1200);
  const check = await qbGet("api/v2/app/preferences");
  const nowDl = Number(check.data && check.data.dl_limit) || 0;
  console.log("  restore ->", restored, "| dl_limit now:", nowDl,
    nowDl === origDl ? "OK" : "FAILED");

  console.log("pageErrors:", errors.length ? errors : "none");
  c.ws.close();
  console.log("done");
  process.exit(0);
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
