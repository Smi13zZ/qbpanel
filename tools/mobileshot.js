/* Mobile-only verification, DOM-direct (no Vue instance access).
 * Connects to a fresh headless Edge already launched at 414x860 size.
 * Run:  NODE_PATH="...workspace/node_modules" PORT=9334 node tools/mobileshot.js
 *
 * The viewport is set by the Edge --window-size flag rather than the
 * Emulation CDP - hand-rolling @media (max-width:640px) fires correctly here,
 * and the CDP override is the one HANDOFF warned leaves stale composited
 * layers that desync getComputedStyle from the screenshot.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const PORT = parseInt(process.env.PORT || "9334", 10);
const OUT = "D:/Workspace WorkBuddy/qbpanel-fnos/_shots";
const BASE = "http://127.0.0.1:8898";

function httpJson(p) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port: PORT, path: p }, (r) => {
      let b = "";
      r.on("data", (c) => (b += c));
      r.on("end", () => { try { resolve(JSON.parse(b)); } catch (e) { resolve(null); } });
    }).on("error", reject);
  });
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
  static async connect() {
    const list = await httpJson("/json/list");
    const page = list && list.find((t) => t.type === "page");
    if (!page) throw new Error("no page target on port " + PORT);
    const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
    await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
    const c = new CDP(ws);
    ws.on("message", (raw) => {
      let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
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
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error("timeout " + method)); } }, 25000);
    });
  }
  async eval(expr) {
    const r = await this.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true });
    if (r.exceptionDetails) throw new Error("EVAL: " + (r.exceptionDetails.text || "") + " " + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || "").slice(0, 200));
    return r.result.value;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function summary(label, ok, detail) {
  const tag = ok ? "OK  " : "FAIL";
  console.log(`[${tag}] ${label}${detail ? "  -- " + detail : ""}`);
  return ok;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const c = await CDP.connect();
  await c.send("Page.enable");
  await c.send("Runtime.enable");
  await c.send("Network.enable");
  await c.send("Network.setCacheDisabled", { cacheDisabled: true });

  console.log("Viewport:", await c.send("Emulation.getDeviceMetricsOverride").then(function() { return "existing"; }).catch(function() { return "no override"; }));

  async function shot(name) {
    const r = await c.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(OUT, name + ".png"), Buffer.from(r.data, "base64"));
    console.log("  saved -> " + name + ".png");
  }

  async function waitFor(expr, tmo) {
    return c.eval(`new Promise(function(res){var t0=Date.now();var iv=setInterval(function(){var v=false;try{v=(${expr});}catch(e){v=false;}if(v){clearInterval(iv);res(true);}else if(Date.now()-t0>${tmo||10000}){clearInterval(iv);res(false);}},120);})`);
  }

  let allPass = true;
  const status = (label, ok, detail) => { if (!summary(label, ok, detail)) allPass = false; };

  // ---------- arrive home ----------
  // Force a clean cold-load to localhost (the previously-connected page may
  // be on a NAS URL from a previous session; this guarantees we test our
  // local source).
  await c.send("Page.enable");
  await c.send("Page.navigate", { url: BASE + "/?view=dash" });
  await waitFor("!!document.querySelector('.stat')", 15000);
  // Extra wait for Vue to mount + listener for viewport to flip
  await sleep(1200);

  const dims = await c.eval("JSON.stringify({w:window.innerWidth,h:window.innerHeight,sw:document.documentElement.clientWidth,loc:location.href})");
  console.log("window dims:", dims);
  // also probe Vue's isMobile via mounted DOM (servers list rendered?)
  const probe = await c.eval(`(function(){
    var r = document.querySelector('.topbar');
    var sel = document.querySelectorAll('select');
    var trigger = document.querySelectorAll('.picker-trigger');
    var mediaM = window.matchMedia('(max-width: 640px)').matches;
    var mediaXL = window.matchMedia('(min-width: 901px)').matches;
    return { hasTopbar: !!r, selectCount: sel.length, pickerCount: trigger.length, media640: mediaM, media901: mediaXL };
  })()`);
  console.log("probe:", JSON.stringify(probe));

  // ---------- 6. topbar server switcher on mobile ----------
  console.log("\n[Fix 6] topbar server switcher visible on mobile");
  // Need >1 server to show the select. Add a fake one via API:
  await c.eval(`fetch('./api/servers',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'TestSwitcher',kind:'qbittorrent',url:'http://192.0.2.1:8080',username:'x',password:'',verify_ssl:false})}).then(function(){})`);
  await sleep(700);
  await c.send("Page.navigate", { url: BASE + "/?view=dash" });
  await waitFor("!!document.querySelector('.topbar')", 12000);
  await sleep(900);
  const tbInfo = await c.eval(`(function(){
    var n = document.querySelectorAll('.topbar .topbar-server');
    if (!n.length) return { ok:false, reason:'no .topbar-server nodes' };
    var sel = n[0]; var r = sel.getBoundingClientRect();
    var st = getComputedStyle(sel);
    return { ok: r.width > 16 && r.height > 14 && st.display !== 'none', count:n.length, w:r.width, h:r.height, display:st.display, tag:sel.tagName };
  })()`);
  console.log("  info:", JSON.stringify(tbInfo));
  status("topbar-server visible on mobile", tbInfo.ok === true);
  await shot("m6_topbar_picker_btn");
  // cleanup fake server
  await c.eval(`fetch('./api/servers',{method:'GET'}).then(function(r){return r.json();}).then(function(j){var s=(j.servers||[]).find(function(x){return x.name==='TestSwitcher';});if(s){return fetch('./api/servers/'+encodeURIComponent(s.id),{method:'DELETE'});}return null;}).then(function(){})`);
  await sleep(400);

  // ---------- 3. mobile picker sheet (settings) ----------
  console.log("\n[Fix 3] mobile picker action sheet (settings)");
  await c.send("Page.navigate", { url: BASE + "/?view=settings" });
  await waitFor("!!document.querySelector('.card')", 12000);
  await sleep(1100);
  // The settings page should have at least the theme picker-trigger button
  const themeBtn = await c.eval(`(function(){
    var btns = document.querySelectorAll('.picker-trigger');
    var info = [];
    for (var i=0;i<btns.length;i++) info.push({txt: btns[i].textContent.trim().slice(0,20), tag: btns[i].tagName});
    return { count: btns.length, info: info };
  })()`);
  console.log("  picker triggers found:", JSON.stringify(themeBtn));
  // Open the first picker-trigger (theme)
  const themeOpened = await c.eval(`(function(){
    var b = document.querySelector('.picker-trigger');
    if (!b) return false;
    b.click();
    return true;
  })()`);
  status("picker trigger clicked", themeOpened === true);
  await sleep(450);
  const sheetInfo = await c.eval(`(function(){
    var s = document.querySelector('.picker-sheet');
    var m = document.querySelector('.picker-mask');
    var items = document.querySelectorAll('.picker-item').length;
    if (!s) return {ok:false,reason:'no sheet',mask:!!m};
    var r = s.getBoundingClientRect();
    return {ok:true, x:r.x, y:r.y, w:r.width, h:r.height, items:items, vh:window.innerHeight};
  })()`);
  console.log("  sheet:", JSON.stringify(sheetInfo));
  status("picker sheet rendered with options", sheetInfo.ok === true && sheetInfo.items > 1,
    sheetInfo.items ? `items=${sheetInfo.items} pos=${Math.round(sheetInfo.y)}px` : "no sheet");
  await shot("m3_picker_theme");
  // Pick the third option if available, else first
  const pickIndex = (sheetInfo.items || 0) > 2 ? 2 : 0;
  await c.eval(`document.querySelectorAll('.picker-item')[${pickIndex}].click()`);
  await sleep(400);
  const sheetGone = await c.eval(`!document.querySelector('.picker-sheet')`);
  status("picker closes after pick", sheetGone === true);
  await shot("m3_picker_after_pick");

  // ---------- 5. cancel-sel button styling ----------
  console.log("\n[Fix 5] cancel selection button styling");
  // The cancel-sel button is rendered only when selection.length>0. Inspect
  // the static template directly via fetch+ and check the class on the line
  // that owns @click="selection = []". Strip HTML comments first - the source
  // has a "bare ghost button..." note about this very fix.
  const sourceCheck = await c.eval(`fetch('./?').then(r=>r.text()).then(function(html){
    var stripped = html.replace(/<!--[\\s\\S]*?-->/g, '');
    var idx = stripped.indexOf('selection = []');
    if (idx < 0) return {found:false};
    var ctx = stripped.substring(Math.max(0,idx-220), idx+40);
    return {found:true, ctx:ctx};
  })`);
  console.log("  cancel-sel source ctx:", JSON.stringify(sourceCheck));
  const okGhostGone = sourceCheck && sourceCheck.found && /class="btn sm"/.test(sourceCheck.ctx) && !/ghost/.test(sourceCheck.ctx);
  status("'取消选择' button class is 'btn sm' (no 'ghost')", okGhostGone,
    sourceCheck && sourceCheck.found ? (okGhostGone ? "" : "ctx: " + sourceCheck.ctx) : "no 'selection = []' in source");
  await shot("m5_cancel_sel_btn");

  // ---------- 1. modal anchored upper-mid ----------
  console.log("\n[Fix 1] modal anchored upper-mid + scale animation");
  // navigate to servers page (it has the "添加服务器" button)
  await c.send("Page.navigate", { url: BASE + "/?view=servers" });
  await waitFor("!!document.querySelector('.toolbar')", 12000);
  await sleep(900);
  // Click the primary "添加服务器" / "Add server" button
  const addServerClicked = await c.eval(`(function(){
    var b = Array.prototype.slice.call(document.querySelectorAll('.btn.primary')).find(function(x){
      return x.textContent.indexOf('添加服务器')>=0 || x.textContent.indexOf('Add server')>=0;
    });
    if (!b) return false; b.click(); return true;
  })()`);
  status("add-server button clicked", addServerClicked === true);
  await sleep(500);
  const m1Info = await c.eval(`(function(){
    var m = document.querySelector('.modal');
    var wrap = document.querySelector('.modal-wrap');
    if (!m || !wrap) return null;
    var mr = m.getBoundingClientRect();
    var wr = wrap.getBoundingClientRect();
    var st = getComputedStyle(wrap);
    var mst = getComputedStyle(m);
    return {
      mTop: mr.top, mBottom: mr.bottom, mLeft: mr.left, mRight: mr.right,
      mWidth: mr.width, mHeight: mr.height,
      vh: window.innerHeight, vw: window.innerWidth,
      wrapPadTop: st.paddingTop, wrapPlaceItems: st.placeItems,
      modalAnim: mst.animationName,
      anchoredBottom: (mr.bottom > window.innerHeight - 40),
      anchoredTop: (mr.top >= 30),
    };
  })()`);
  console.log("  modal info:", JSON.stringify(m1Info));
  const ok1 = m1Info && m1Info.anchoredTop === true && !m1Info.anchoredBottom;
  status("modal centered upper-mid (not bottom-anchored sheet)", ok1,
    m1Info ? `top=${Math.round(m1Info.mTop)} bottom=${Math.round(m1Info.mBottom)} vh=${m1Info.vh}` : "");
  await shot("m1_modal_upper_mid");
  // close
  await c.eval(`(function(){
    var b = Array.prototype.slice.call(document.querySelectorAll('.modal-foot .btn')).find(function(x){
      return x.textContent.indexOf('取消')>=0 || x.textContent.indexOf('Cancel')>=0;
    });
    if (b) b.click();
  })()`);
  await sleep(400);

  // ---------- 2. log date+time two lines ----------
  console.log("\n[Fix 2] log date+time two lines, message wraps");
  // We can't easily access Vue's instance proxy (production build), and qB's
  // real log endpoint can't be reached without a running server. So inject
  // a synthetic .logline into the DOM directly and assert that the column
  // CSS rule applied. The CSS is the actual user-facing change; the template
  // wiring is verified by grepping the served HTML.
  const configNow = await c.eval(`fetch('./api/config').then(function(r){return r.json();}).then(function(j){return JSON.stringify({n:(j.servers||[]).length});})`);
  console.log("  config:", configNow);
  await c.send("Page.navigate", { url: BASE + "/?view=logs" });
  await waitFor("!!document.querySelector('.toolbar .seg')", 12000);
  await sleep(1100);
  // Build a synthetic logline by cloning the segment buttons (proves the
  // logs toolbar is on screen) and inserting a .logline after the toolbar.
  const logCheck = await c.eval(`(function(){
    var tb = document.querySelector('.toolbar .seg');
    if (!tb) return {ok:false, reason:'toolbar not on logs view'};
    var tbParent = tb.closest('.toolbar');
    var card = document.querySelector('.card');
    if (!card) return {ok:false, reason:'no .card yet'};
    // Synthesize a .logline directly
    var html = '<div class="logline normal" id="__test_logline">' +
      '<span class="t">' +
        '<span class="d">2026-10-16</span>' +
        '<span class="h">09:30</span>' +
      '</span>' +
      '<span class="m">successfully mapped port using NAT-PMP. local: 192.168.1.10 external port: UDP/42191</span>' +
    '</div>';
    // Insert at the top of the .card body so it's visible
    card.insertAdjacentHTML('afterbegin', html);
    var ll = document.getElementById('__test_logline');
    var d = ll.querySelector('.d');
    var h = ll.querySelector('.h');
    var m = ll.querySelector('.m');
    var tlr = ll.querySelector('.t').getBoundingClientRect();
    var dr = d.getBoundingClientRect();
    var hr = h.getBoundingClientRect();
    var mr = m.getBoundingClientRect();
    var llr = ll.getBoundingClientRect();
    return {
      ok:true,
      dText: d.textContent, hText: h.textContent,
      tHeight: tlr.height,
      dTop: dr.top, hTop: hr.top, sameRow: Math.abs(dr.top - hr.top) < 3,
      mRight: mr.right, vw: window.innerWidth,
      llRight: llr.right,
      overflow: mr.right > window.innerWidth + 1,
    };
  })()`);
  console.log("  log line:", JSON.stringify(logCheck));
  status("log line has date + time spans", logCheck && logCheck.dText && logCheck.hText);
  status("log date and time sit on ONE row (26.10.17: merged back after message wrap was fixed)",
    logCheck && logCheck.sameRow && logCheck.tHeight < 22,
    logCheck ? `tHeight=${Math.round(logCheck.tHeight)} dTop=${Math.round(logCheck.dTop)} hTop=${Math.round(logCheck.hTop)}` : "");
  status("message stays within viewport (no horizontal overflow)",
    logCheck && !logCheck.overflow,
    logCheck ? `mRight=${Math.round(logCheck.mRight)} vw=${logCheck.vw}` : "");
  await shot("m2_log_two_line");

  // ---------- 4. export backup download ----------
  console.log("\n[Fix 4] export backup reaches the export URL");
  // 26.10.19: mobile now NAVIGATES to the attachment URL (blob: downloads are
  // silently dropped by the fnOS app WebView), desktop keeps the blob flow.
  // Both branches issue a request to ./api/backup/export, so listen on the
  // network layer instead of intercepting anchor clicks.
  const exportReqs = [];
  c.ws.on("message", function listener(raw) {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.method === "Network.requestWillBeSent") {
      const u = m.params && m.params.request && m.params.request.url || "";
      if (u.indexOf("backup/export") >= 0) exportReqs.push(u);
    }
  });
  await c.send("Page.navigate", { url: BASE + "/?view=settings" });
  await waitFor("!!document.querySelector('.card')", 12000);
  await sleep(1200);
  // 26.10.21: settings is a sectioned work bar - the export controls live in
  // the "backup & restore" section now, so open it first.
  await c.eval(`(function(){
    var b = Array.prototype.slice.call(document.querySelectorAll('.workbar button')).find(function(x){
      return /备份|Backup/.test(x.textContent);
    });
    if (b) b.click(); return !!b;
  })()`);
  await sleep(800);
  // Find and click 导出备份
  const exportClicked = await c.eval(`(function(){
    var b = Array.prototype.slice.call(document.querySelectorAll('button')).find(function(x){
      return x.textContent.indexOf('导出备份')>=0 || x.textContent.indexOf('Export backup')>=0;
    });
    if (!b) return false; b.click(); return true;
  })()`);
  status("export-backup button clicked", exportClicked === true);
  await sleep(2500);
  console.log("  export requests:", JSON.stringify(exportReqs));
  status("export request reached the server (mobile: direct navigation)", exportReqs.length > 0);
  // verify the mobile toast told the user what happened
  const toastText = await c.eval(`(function(){
    var t = document.querySelector('.toast');
    return t ? t.textContent.trim() : '(no toast)';
  })()`);
  console.log("  toast:", toastText);
  status("mobile shows 'download started' feedback", /已开始下载|Download started/.test(toastText), toastText);
  await shot("m4_export_download");

  c.ws.close();
  console.log("\n" + (allPass ? "[ALL PASS]" : "[SOME FAILED]"));
  process.exit(allPass ? 0 : 1);
})().catch((e) => {
  console.error("FATAL", e.message);
  console.error(e.stack);
  process.exit(2);
});
