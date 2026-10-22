/* qbpanel - HTTP layer
 *
 * Every request uses a RELATIVE url on purpose: when the panel is opened from
 * the fnOS desktop the page lives under /cgi/ThirdParty/qbpanel/index.cgi/ and
 * an absolute "/api/..." would escape the app's CGI mount point entirely.
 */
(function () {
  "use strict";

  const BASE = "./api";

  function qs(params) {
    if (!params) return "";
    const p = new URLSearchParams();
    Object.keys(params).forEach(function (k) {
      const v = params[k];
      if (v === undefined || v === null || v === "") return;
      p.append(k, v);
    });
    const s = p.toString();
    return s ? "?" + s : "";
  }

  async function request(path, opts) {
    opts = opts || {};
    const init = {
      method: opts.method || "GET",
      headers: Object.assign({}, opts.headers || {}),
      cache: "no-store",
    };
    if (opts.body !== undefined && opts.body !== null) {
      if (opts.raw) {
        init.body = opts.body;
      } else if (typeof opts.body === "string") {
        init.body = opts.body;
      } else if (opts.form) {
        init.headers["Content-Type"] = "application/x-www-form-urlencoded";
        init.body = new URLSearchParams(opts.body).toString();
      } else {
        init.headers["Content-Type"] = "application/json";
        init.body = JSON.stringify(opts.body);
      }
    }
    let resp;
    try {
      resp = await fetch(path, init);
    } catch (e) {
      throw new Error("网络不可达");
    }
    const text = await resp.text();
    if (opts.rawResponse) {
      return { status: resp.status, text: text };
    }
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch (e) {
        data = text;
      }
    }
    if (!resp.ok) {
      const msg = (data && data.error) || (typeof data === "string" && data) || ("HTTP " + resp.status);
      const err = new Error(typeof msg === "string" ? msg.slice(0, 300) : "请求失败");
      err.status = resp.status;
      err.payload = data;
      throw err;
    }
    return data;
  }

  const API = {
    base: BASE,

    health: function () {
      return request(BASE + "/health");
    },

    /* ---- panel configuration ---- */
    config: function () {
      return request(BASE + "/config");
    },
    saveSettings: function (settings) {
      return request(BASE + "/config", { method: "POST", body: { settings: settings } });
    },
    servers: function () {
      return request(BASE + "/servers");
    },
    addServer: function (srv) {
      return request(BASE + "/servers", { method: "POST", body: srv });
    },
    updateServer: function (id, srv) {
      return request(BASE + "/servers/" + encodeURIComponent(id), { method: "POST", body: srv });
    },
    deleteServer: function (id) {
      return request(BASE + "/servers/" + encodeURIComponent(id), { method: "DELETE" });
    },
    testServer: function (id, srv) {
      return request(BASE + "/servers/" + encodeURIComponent(id) + "/test", {
        method: "POST",
        body: srv || {},
      });
    },
    setCurrent: function (id) {
      return request(BASE + "/current", { method: "POST", body: { id: id } });
    },

    /* ---- backups ---- */
    exportUrl: BASE + "/backup/export",
    backupStatus: function () {
      return request(BASE + "/backup/status");
    },
    backupToFolder: function () {
      return request(BASE + "/backup/to-folder", { method: "POST" });
    },
    backupRun: function () {
      return request(BASE + "/backup/run", { method: "POST" });
    },
    backupImport: function (file) {
      return request(BASE + "/backup/import", {
        method: "POST",
        raw: true,
        body: file,
        headers: { "Content-Type": "application/json" },
      });
    },
    backupRestore: function (name) {
      return request(BASE + "/backup/restore", { method: "POST", body: { name: name } });
    },
    backupDelete: function (name) {
      return request(BASE + "/backup/delete", { method: "POST", body: { name: name } });
    },

    /* ---- release check / one-click update ---- */
    updateCheck: function (force) {
      return request(BASE + "/update/check" + (force ? "?force=1" : ""));
    },
    installUpdate: function () {
      return request(BASE + "/update/install", { method: "POST", body: {} });
    },
    updateStatus: function () {
      return request(BASE + "/update/status");
    },

    /* ---- notifications ---- */
    notify: function () {
      return request(BASE + "/notify");
    },
    notifySettings: function (settings) {
      return request(BASE + "/notify/settings", { method: "POST", body: settings });
    },
    saveChannel: function (channel) {
      return request(BASE + "/notify/channel", { method: "POST", body: channel });
    },
    deleteChannel: function (id) {
      return request(BASE + "/notify/channel/" + encodeURIComponent(id), { method: "DELETE" });
    },
    testChannel: function (id) {
      return request(BASE + "/notify/test", { method: "POST", body: { id: id } });
    },
    notifyLog: function (limit) {
      return request(BASE + "/notify/log" + (limit ? "?limit=" + encodeURIComponent(limit) : ""));
    },
    clearNotifyLog: function () {
      return request(BASE + "/notify/log", { method: "DELETE" });
    },

    /* ---- BitTorrent proxy (qBittorrent WebAPI v2 dialect) ---- */
    qb: function (path, opts) {
      opts = opts || {};
      const url = BASE + "/qb/" + path.replace(/^\//, "") + qs(opts.params);
      return request(url, {
        method: opts.method || "GET",
        body: opts.body,
        form: opts.form,
        raw: opts.raw,
        headers: opts.headers,
        rawResponse: opts.rawResponse,
      });
    },

    /* ---- torrent file upload (raw bytes) ---- */
    uploadTorrent: function (file, params) {
      return request(BASE + "/upload" + qs(params), {
        method: "POST",
        raw: true,
        body: file,
        headers: { "Content-Type": "application/x-bittorrent" },
      });
    },
  };

  window.API = API;
})();
