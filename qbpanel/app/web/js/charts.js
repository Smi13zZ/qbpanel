/* qbpanel - tiny dependency-free canvas charts (speed sparkline + donut) */
(function () {
  "use strict";

  function cssVar(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name);
    return (v && v.trim()) || fallback;
  }

  function fitCanvas(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width));
    const h = Math.max(1, Math.floor(rect.height || canvas.clientHeight || 120));
    if (canvas.width !== Math.floor(w * dpr) || canvas.height !== Math.floor(h * dpr)) {
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
    }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return { ctx: ctx, w: w, h: h };
  }

  function fmtAxis(v) {
    if (v <= 0) return "0";
    const u = ["B", "K", "M", "G", "T"];
    let i = 0;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)) + u[i];
  }

  /* ------------------------------------------------------------------ */
  /* Speed sparkline: two stacked series (download / upload)             */
  /* ------------------------------------------------------------------ */
  function SpeedChart(canvas, capacity) {
    this.canvas = canvas;
    this.capacity = capacity || 90;
    this.dl = [];
    this.ul = [];
  }

  /* The canvas element is torn down and rebuilt every time the view switches
     (the page templates are behind v-if), while this chart instance is cached
     for the lifetime of the app. Without re-binding, draw() keeps painting the
     detached old element and the fresh canvas stays blank forever. */
  SpeedChart.prototype.attach = function (canvas) {
    if (canvas && canvas !== this.canvas) this.canvas = canvas;
  };

  SpeedChart.prototype.push = function (dl, ul) {
    this.dl.push(Number(dl) || 0);
    this.ul.push(Number(ul) || 0);
    while (this.dl.length > this.capacity) this.dl.shift();
    while (this.ul.length > this.capacity) this.ul.shift();
    this.draw();
  };

  SpeedChart.prototype.reset = function () {
    this.dl = [];
    this.ul = [];
    this.draw();
  };

  SpeedChart.prototype.draw = function () {
    const c = fitCanvas(this.canvas);
    const ctx = c.ctx, W = c.w, H = c.h;
    if (!W || !H) return;

    const padL = 44, padR = 8, padT = 10, padB = 16;
    const gw = Math.max(1, W - padL - padR);
    const gh = Math.max(1, H - padT - padB);

    const border = cssVar("--border-soft", "#1e2833");
    const faint = cssVar("--faint", "#5c6674");

    const peak = Math.max(1, Math.max.apply(null, this.dl.concat(this.ul)));
    const nice = niceCeil(peak);

    ctx.font = "10px " + cssVar("--mono", "monospace");
    ctx.textBaseline = "middle";

    for (let i = 0; i <= 4; i++) {
      const y = padT + (gh * i) / 4;
      ctx.strokeStyle = border;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padL, Math.round(y) + 0.5);
      ctx.lineTo(padL + gw, Math.round(y) + 0.5);
      ctx.stroke();
      ctx.fillStyle = faint;
      ctx.textAlign = "right";
      ctx.fillText(fmtAxis(nice * (1 - i / 4)), padL - 7, y);
    }

    const series = [
      { data: this.dl, color: cssVar("--dl", "#38bdf8") },
      { data: this.ul, color: cssVar("--ul", "#f59e0b") },
    ];

    series.forEach(function (s) {
      const pts = s.data;
      if (pts.length < 2) return;
      const n = pts.length;
      const step = gw / Math.max(1, n - 1);
      const xy = pts.map(function (v, i) {
        return [padL + i * step, padT + gh - Math.min(1, v / nice) * gh];
      });

      ctx.beginPath();
      ctx.moveTo(xy[0][0], xy[0][1]);
      for (let i = 1; i < xy.length; i++) {
        const p0 = xy[i - 1], p1 = xy[i];
        const cx = (p0[0] + p1[0]) / 2;
        ctx.bezierCurveTo(cx, p0[1], cx, p1[1], p1[0], p1[1]);
      }
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 1.6;
      ctx.lineJoin = "round";
      ctx.stroke();

      ctx.lineTo(xy[xy.length - 1][0], padT + gh);
      ctx.lineTo(xy[0][0], padT + gh);
      ctx.closePath();
      const grad = ctx.createLinearGradient(0, padT, 0, padT + gh);
      grad.addColorStop(0, hexA(s.color, 0.28));
      grad.addColorStop(1, hexA(s.color, 0.01));
      ctx.fillStyle = grad;
      ctx.fill();
    });
  };

  function niceCeil(v) {
    if (v <= 0) return 1024;
    const exp = Math.pow(1024, Math.floor(Math.log(v) / Math.log(1024)));
    const n = v / exp;
    const steps = [1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96, 128];
    for (let i = 0; i < steps.length; i++) {
      if (n <= steps[i]) return steps[i] * exp;
    }
    return 256 * exp;
  }

  /* Accepts "#rrggbb" or "var(...)" - resolve plain hex with alpha. */
  function hexA(color, a) {
    const m = /^#([0-9a-f]{6})$/i.exec(color);
    if (!m) return color;
    const n = parseInt(m[1], 16);
    return "rgba(" + ((n >> 16) & 255) + "," + ((n >> 8) & 255) + "," + (n & 255) + "," + a + ")";
  }

  /* ------------------------------------------------------------------ */
  /* Donut chart                                                         */
  /* ------------------------------------------------------------------ */
  function drawDonut(canvas, segments, label) {
    const c = fitCanvas(canvas);
    const ctx = c.ctx, W = c.w, H = c.h;
    const cx = W / 2, cy = H / 2;
    const rOuter = Math.max(10, Math.min(W, H) / 2 - 6);
    const rInner = rOuter * 0.62;
    const total = segments.reduce(function (a, s) { return a + (s.value || 0); }, 0);

    if (!total) {
      ctx.beginPath();
      ctx.arc(cx, cy, (rOuter + rInner) / 2, 0, Math.PI * 2);
      ctx.strokeStyle = cssVar("--border", "#e5e5e5");
      ctx.lineWidth = rOuter - rInner;
      ctx.stroke();
      return;
    }

    let start = -Math.PI / 2;
    segments.forEach(function (s) {
      if (!s.value) return;
      const ang = (s.value / total) * Math.PI * 2;
      ctx.beginPath();
      ctx.arc(cx, cy, (rOuter + rInner) / 2, start, start + ang);
      ctx.strokeStyle = s.color;
      ctx.lineWidth = rOuter - rInner;
      ctx.lineCap = "butt";
      ctx.stroke();
      start += ang;
    });

    ctx.fillStyle = cssVar("--text", "#0a0a0a");
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    if (label) {
      ctx.font = "600 18px -apple-system, sans-serif";
      ctx.fillText(String(total), cx, cy - 7);
      ctx.fillStyle = cssVar("--faint", "#a3a3a3");
      ctx.font = "11px -apple-system, sans-serif";
      ctx.fillText(label, cx, cy + 12);
    } else {
      ctx.font = "600 20px -apple-system, sans-serif";
      ctx.fillText(String(total), cx, cy);
    }
  }

  window.QBP_CHART = {
    SpeedChart: SpeedChart,
    drawDonut: drawDonut,
    cssVar: cssVar,
    hexA: hexA,
  };
})();
