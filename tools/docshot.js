/* Documentation screenshots for qBpanel (README / 教程).
 *
 * Run (after starting headless Edge on port 9333):
 *   node tools/docshot.js desktop [baseUrl]
 *   node tools/docshot.js mobile  [baseUrl]
 *
 * Two separate runs on purpose: Emulation.setDeviceMetricsOverride persists
 * across navigations inside one browser session, so mixing viewports in a
 * single process leaks mobile layout into the desktop shots.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const MODE = (process.argv[2] || "desktop").toLowerCase();
const BASE = process.argv[3] || "http://127.0.0.1:8898";
const OUT = "D:/Workspace WorkBuddy/qbpanel-fnos/docs/images";
const PORT = 9333;

const VIEW = MODE === "mobile"
  ? { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }
  : { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false };

function httpJson(p) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port: PORT, path: p }, (r) => {
      let b = "";
      r.on("data", (c) => (b += c));
      r.on("end", () => resolve(JSON.parse(b)));
    }).on("error", reject);
  });
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
  static async connect() {
    const list = await httpJson("/json/list");
    const page = list.find((t) => t.type === "page");
    if (!page) throw new Error("no page target");
    const ws = new WebSocket(page.webSocketDebuggerUrl, {
      perMessageDeflate: false, maxPayload: 256 * 1024 * 1024,
    });
    await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
    const c = new CDP(ws);
    ws.on("message", (raw) => {
      let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.id && c.pending.has(msg.id)) {
        const { res, rej } = c.pending.get(msg.id); c.pending.delete(msg.id);
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
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error("timeout " + method)); } }, 30000);
    });
  }
  async eval(expr) {
    const r = await this.send("Runtime.evaluate", {
      expression: expr, returnByValue: true, awaitPromise: true, userGesture: true,
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
  await c.send("Network.enable");
  await c.send("Network.setCacheDisabled", { cacheDisabled: true });
  await c.send("Emulation.setDeviceMetricsOverride", VIEW);

  async function shot(name) {
    const r = await c.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(OUT, name + ".png"), Buffer.from(r.data, "base64"));
    console.log("shot ->", name + ".png");
  }
  async function waitFor(expr, ms) {
    return c.eval(`new Promise(function(res){var t0=Date.now();var iv=setInterval(function(){var v=false;try{v=(${expr});}catch(e){v=false;}if(v){clearInterval(iv);res(true);}else if(Date.now()-t0>${ms || 15000}){clearInterval(iv);res(false);}},150);})`);
  }
  const click = (sel) => c.eval(`(function(){var e=document.querySelector(${JSON.stringify(sel)});if(!e)return false;e.click();return true;})()`);

  // Public IPs (our own WAN address shows up in the log, peer addresses in the
  // peers table) are rewritten to the RFC 5737 documentation range. Private
  // ranges are left alone - they say nothing about the reader's network.
  const sanitizeIPs = () => c.eval(`(function(){
    var doc = document;
    var walk = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    var n, hits = 0;
    while ((n = walk.nextNode())) {
      if (n.__ipdone) continue;
      var old = n.nodeValue;
      var neu = old.replace(/\\b\\d{1,3}(?:\\.\\d{1,3}){3}\\b/g, function (ip) {
        if (/^(10\\.|127\\.|192\\.168\\.|172\\.(1[6-9]|2\\d|3[01])\\.|0\\.)/.test(ip)) return ip;
        hits++;
        return '203.0.113.7';
      });
      if (neu !== old) { n.nodeValue = neu; n.__ipdone = 1; }
    }
    return hits;
  })()`);

  async function load(url) {
    await c.send("Page.navigate", { url: url });
    await waitFor("!!document.querySelector('.side-foot')", 25000);
    // let the speed chart collect a few samples so the curve is not empty
    await sleep(2800);
  }

  const root = BASE;

  if (MODE === "desktop") {
    await load(root + "/?view=dash&theme=light&lang=zh");
    await shot("overview-light");

    await load(root + "/?view=dash&theme=dark&lang=zh");
    await shot("overview-dark");

    await load(root + "/?view=torrents&theme=light&lang=zh");
    await shot("torrents");

    // add-torrent dialog
    await click(".content .btn.primary");
    await waitFor("!!document.querySelector('.modal-wrap .modal')", 6000);
    await sleep(700);
    await shot("add-torrent");
    await c.eval(`(function(){var bs=[].slice.call(document.querySelectorAll('.modal-foot .btn'));if(bs[0])bs[0].click();})()`);
    await sleep(600);

    // torrent detail drawer: general / files / trackers / peers
    await c.eval(`(function(){var e=document.querySelector('.tlist tbody tr .name');if(e)e.click();})()`);
    await waitFor("!!document.querySelector('.drawer')", 9000);
    await sleep(2000);
    await shot("torrent-detail");
    for (const [i, name] of [[1, "detail-files"], [2, "detail-trackers"], [3, "detail-peers"]]) {
      const ok = await c.eval(`(function(){var ts=[].slice.call(document.querySelectorAll('.drawer-body .tabs button'));if(ts[${i}]){ts[${i}].click();return true;}return false;})()`);
      await sleep(1600);
      if (!ok) continue;
      if (name === "detail-peers") {
        // the peers table arrives asynchronously, so wait for rows before
        // scrubbing the addresses (otherwise the scrub runs on an empty table)
        await waitFor("document.querySelectorAll('.drawer-body table tbody tr').length > 3", 10000);
        await sleep(700);
        console.log("peer IPs sanitized:", await sanitizeIPs());
        await sleep(200);
      }
      await shot(name);
    }
    await c.eval(`(function(){var e=document.querySelector('.drawer .drawer-head .icon-btn');if(e)e.click();})()`);
    await sleep(700);

    await load(root + "/?view=servers&theme=light&lang=zh");
    // Sanitized for publication: the real LAN addresses and account names are
    // swapped for placeholders in the DOM only, right before the capture.
    await c.eval(`(function(){
      var keep = { 'qBittorrent':1, 'Transmission':1, 'TLS':1, 'no-TLS':1,
                   '当前':1, '正常':1, '失败':1, '未检测':1, '测试中…':1 };
      var cards = [].slice.call(document.querySelectorAll('.content .card'));
      cards.forEach(function (card, i) {
        var b = card.querySelector('b.ellipsis');
        if (b) b.textContent = ['Home NAS qBittorrent', 'Media Server', 'Seedbox'][i] || ('Server ' + (i + 1));
        var u = card.querySelector('.mono.dim');
        if (u) u.textContent = 'http://192.168.1.' + (20 + i) + ':8080';
        [].slice.call(card.querySelectorAll('.chip')).forEach(function (ch) {
          var tx = (ch.textContent || '').trim();
          if (tx && !keep[tx]) ch.textContent = 'user';
        });
      });
    })()`);
    await sleep(900);
    await shot("servers");

    // add-server dialog
    await click(".content .btn.primary");
    await waitFor("!!document.querySelector('.modal-wrap .modal')", 6000);
    await sleep(800);
    await shot("add-server");
    await c.eval(`(function(){var bs=[].slice.call(document.querySelectorAll('.modal-foot .btn'));if(bs[0])bs[0].click();})()`);
    await sleep(600);

    await load(root + "/?view=stats&theme=light&lang=zh");
    await shot("stats");

    await load(root + "/?view=logs&theme=light&lang=zh");
    // the "normal" level is often empty; "info" always carries tracker activity
    await c.eval(`(function(){var bs=[].slice.call(document.querySelectorAll('.toolbar .seg button'));if(bs[1]){bs[1].click();return true;}return false;})()`);
    await sleep(1800);
    console.log("log IPs sanitized:", await sanitizeIPs());
    await shot("logs");

    await load(root + "/?view=settings&theme=dark&lang=zh");
    await shot("settings");
    await c.eval(`(function(){var m=document.querySelector('.main');if(m)m.scrollTop=m.scrollHeight;window.scrollTo(0,document.body.scrollHeight);})()`);
    await sleep(1200);
    await shot("settings-backup");
  } else {
    await load(root + "/?view=dash&theme=light&lang=zh");
    await shot("mobile-overview");

    await click(".topbar .icon-btn.mobile-only");
    await sleep(1200);
    await shot("mobile-sidebar");
    await click(".mask");
    await sleep(900);

    await load(root + "/?view=torrents&theme=light&lang=zh");
    await shot("mobile-torrents");

    await click(".content .btn.primary");
    await waitFor("!!document.querySelector('.modal-wrap .modal')", 6000);
    await sleep(900);
    await shot("mobile-add");
    await c.eval(`(function(){var bs=[].slice.call(document.querySelectorAll('.modal-foot .btn'));if(bs[0])bs[0].click();})()`);
    await sleep(700);

    await load(root + "/?view=settings&theme=dark&lang=zh");
    await shot("mobile-settings");
    await click(".content .select.picker-trigger");
    await sleep(1200);
    await shot("mobile-picker");
  }

  c.ws.close();
  console.log("done:", MODE);
  process.exit(0);
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
