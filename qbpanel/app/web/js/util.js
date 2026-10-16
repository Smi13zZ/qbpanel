/* qbpanel - formatting helpers and torrent state metadata */
(function () {
  "use strict";

  const UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];

  function fmtBytes(n, digits) {
    n = Number(n) || 0;
    if (n <= 0) return "0 B";
    let i = 0;
    while (n >= 1024 && i < UNITS.length - 1) {
      n /= 1024;
      i++;
    }
    const d = digits === undefined ? (i === 0 ? 0 : n >= 100 ? 0 : n >= 10 ? 1 : 2) : digits;
    return n.toFixed(d) + " " + UNITS[i];
  }

  function fmtSpeed(n) {
    const v = Number(n) || 0;
    if (v <= 0) return "—";
    return fmtBytes(v) + "/s";
  }

  function fmtPercent(p, digits) {
    const v = (Number(p) || 0) * 100;
    return v.toFixed(digits === undefined ? 1 : digits) + "%";
  }

  function fmtEta(sec) {
    sec = Number(sec);
    if (!sec || sec <= 0 || sec >= 8640000) return "∞";
    return fmtDuration(sec);
  }

  function fmtDuration(sec) {
    sec = Math.max(0, Math.floor(Number(sec) || 0));
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (d > 0) return d + "天" + h + "小时";
    if (h > 0) return h + ":" + String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
    if (m > 0) return m + ":" + String(s).padStart(2, "0");
    return s + "秒";
  }

  function fmtRatio(r) {
    r = Number(r);
    if (!isFinite(r) || r < 0) return "—";
    return r.toFixed(2);
  }

  function fmtDate(unix) {
    const v = Number(unix) || 0;
    if (v <= 0) return "—";
    const d = new Date(v * 1000);
    const p = (x) => String(x).padStart(2, "0");
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
      " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }

  /* ---- states ----
   * qBittorrent 5.0 renamed pausedDL/pausedUP to stoppedDL/stoppedUP and added
   * forcedMetaDL; keep both spellings so 4.x and 5.x render identically. */
  const STATE_MAP = {
    error: { label: "错误", group: "error", tone: "err" },
    missingFiles: { label: "文件缺失", group: "error", tone: "err" },
    uploading: { label: "做种中", group: "seeding", tone: "ok" },
    stalledUP: { label: "做种中", group: "seeding", tone: "ok" },
    forcedUP: { label: "强制做种", group: "seeding", tone: "ok" },
    queuedUP: { label: "排队做种", group: "seeding", tone: "warn" },
    checkingUP: { label: "校验中", group: "seeding", tone: "warn" },
    pausedUP: { label: "已完成", group: "paused", tone: "idle" },
    stoppedUP: { label: "已完成（已停止）", group: "paused", tone: "idle" },
    downloading: { label: "下载中", group: "downloading", tone: "dl" },
    stalledDL: { label: "等待中", group: "downloading", tone: "dl" },
    metaDL: { label: "获取元数据", group: "downloading", tone: "dl" },
    forcedMetaDL: { label: "强制获取元数据", group: "downloading", tone: "dl" },
    forcedDL: { label: "强制下载", group: "downloading", tone: "dl" },
    allocating: { label: "分配空间", group: "downloading", tone: "warn" },
    checkingDL: { label: "校验中", group: "downloading", tone: "warn" },
    queuedDL: { label: "排队下载", group: "downloading", tone: "warn" },
    pausedDL: { label: "已暂停", group: "paused", tone: "idle" },
    stoppedDL: { label: "已停止", group: "paused", tone: "idle" },
    moving: { label: "移动中", group: "other", tone: "warn" },
    checkingResumeData: { label: "校验数据", group: "other", tone: "warn" },
    unknown: { label: "未知", group: "other", tone: "idle" },
  };

  function stateInfo(state) {
    return STATE_MAP[state] || { label: state || "未知", group: "other", tone: "idle" };
  }

  const TONE_COLOR = {
    dl: "var(--dl)",
    ul: "var(--ul)",
    ok: "var(--ok)",
    warn: "var(--warn)",
    err: "var(--err)",
    idle: "var(--idle)",
  };

  function toneColor(tone) {
    return TONE_COLOR[tone] || TONE_COLOR.idle;
  }

  function isActive(t) {
    return ["downloading", "stalledDL", "metaDL", "forcedMetaDL", "forcedDL",
      "allocating", "checkingDL", "queuedDL"].indexOf(t.state) >= 0;
  }

  function isSeeding(t) {
    return ["uploading", "stalledUP", "forcedUP", "queuedUP", "checkingUP"].indexOf(t.state) >= 0;
  }

  function isPaused(t) {
    return ["pausedDL", "pausedUP", "stoppedDL", "stoppedUP"].indexOf(t.state) >= 0;
  }

  function isError(t) {
    return ["error", "missingFiles"].indexOf(t.state) >= 0 || Number(t.error) > 0;
  }

  function isDone(t) {
    return Number(t.progress) >= 1;
  }

  window.QBP_FMT = {
    fmtBytes, fmtSpeed, fmtPercent, fmtEta, fmtDuration, fmtRatio, fmtDate,
    stateInfo, toneColor, isActive, isSeeding, isPaused, isError, isDone,
  };
})();
