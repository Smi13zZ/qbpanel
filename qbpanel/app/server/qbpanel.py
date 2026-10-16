#!/usr/bin/env python3
"""qbpanel : a fnOS native BitTorrent control panel.

Pure Python 3 standard library. Serves the web UI, stores configuration in
$TRIM_PKGVAR and reverse-proxies requests to the configured
qBittorrent / Transmission instance so the browser never needs direct access
to the downloader and its credentials stay server side.
"""
import base64
import json
import mimetypes
import os
import re
import socket
import sys
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import backends  # noqa: E402
from backends import (  # noqa: E402
    APP_NAME,
    VERSION,
    TRClient,
    Store,
    log,
    make_client,
    var_dir,
    web_dir,
)

STORE = None
CLIENTS = {}
CLIENTS_LOCK = threading.RLock()

EXTRA_MIME = {
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".map": "application/json; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".wasm": "application/wasm",
}

# qBittorrent 5.0 renamed these endpoints and removed the 4.x names. Try the
# alias whenever the requested path 404s so one UI works across both majors.
QB_ALIASES = {
    "/api/v2/torrents/pause": ("/api/v2/torrents/stop",),
    "/api/v2/torrents/resume": ("/api/v2/torrents/start",),
}


def guess_type(path):
    ext = os.path.splitext(path)[1].lower()
    if ext in EXTRA_MIME:
        return EXTRA_MIME[ext]
    return mimetypes.guess_type(path)[0] or "application/octet-stream"


def client_for(server):
    key = server.get("id") or "default"
    fp = json.dumps(
        {k: server.get(k) for k in ("url", "username", "password", "kind", "verify_ssl")},
        sort_keys=True,
    )
    with CLIENTS_LOCK:
        ent = CLIENTS.get(key)
        if ent and ent[0] == fp:
            return ent[1]
        cli = make_client(server)
        CLIENTS[key] = (fp, cli)
        return cli


def normalize_url(u):
    """Server identity for duplicate detection - case and trailing slash free."""
    return (u or "").strip().rstrip("/").lower()


def public_server(srv):
    out = {
        "id": srv.get("id"),
        "name": srv.get("name") or srv.get("url") or "server",
        "kind": srv.get("kind") or "qbittorrent",
        "url": srv.get("url") or "",
        "username": srv.get("username") or "",
        "verify_ssl": bool(srv.get("verify_ssl", False)),
        "has_password": bool(srv.get("password")),
    }
    return out


def reset_clients():
    """Drop cached clients - call after the server list changes wholesale."""
    with CLIENTS_LOCK:
        CLIENTS.clear()


# --------------------------------------------------------------------------
# automatic backups
# --------------------------------------------------------------------------
BACKUP_STATE_FILE = os.path.join(var_dir(), "backup-state.json")


def load_backup_state():
    try:
        with open(BACKUP_STATE_FILE, "r", encoding="utf-8") as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def save_backup_state(state):
    try:
        tmp = BACKUP_STATE_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(state, f, ensure_ascii=False)
        os.replace(tmp, BACKUP_STATE_FILE)
    except Exception:
        pass


def auto_backup_settings():
    st = (STORE.data.get("settings") or {}) if STORE else {}
    try:
        interval = int(st.get("auto_backup_interval_hours") or 24)
    except (TypeError, ValueError):
        interval = 24
    try:
        retention = int(st.get("auto_backup_retention_days") or 30)
    except (TypeError, ValueError):
        retention = 30
    return {
        "enabled": bool(st.get("auto_backup_enabled")),
        "interval_hours": max(backends.INTERVAL_MIN_HOURS, min(backends.INTERVAL_MAX_HOURS, interval)),
        "retention_days": max(backends.RETENTION_MIN_DAYS, min(backends.RETENTION_MAX_DAYS, retention)),
    }


def run_auto_backup(force=False):
    cfg = auto_backup_settings()
    if not cfg["enabled"] and not force:
        return {"ok": True, "skipped": "disabled"}
    state = load_backup_state()
    now = time.time()
    if not force and state.get("last_success"):
        try:
            due = float(state["last_success"]) + cfg["interval_hours"] * 3600
        except (TypeError, ValueError):
            due = 0
        if now < due:
            return {"ok": True, "skipped": "not_due"}
    try:
        data = backends.make_backup(STORE, "auto")
        path = backends.write_backup(data)
        removed = backends.prune_backups(cfg["retention_days"])
        state.update({
            "last_success": int(now),
            "last_attempt": int(now),
            "last_path": path,
            "last_error": "",
            "removed": removed,
        })
        save_backup_state(state)
        log("auto backup -> %s (pruned %d)" % (path, removed))
        return {"ok": True, "path": path, "removed": removed}
    except Exception as exc:
        state.update({"last_attempt": int(now), "last_error": repr(exc)})
        save_backup_state(state)
        log("auto backup failed: %r" % (exc,))
        return {"ok": False, "error": repr(exc)}


def backup_status():
    cfg = auto_backup_settings()
    state = load_backup_state()
    items = backends.list_backups()
    try:
        last = int(state.get("last_success") or 0)
    except (TypeError, ValueError):
        last = 0
    nxt = (last + cfg["interval_hours"] * 3600) if (cfg["enabled"] and last) else 0
    return {
        "enabled": cfg["enabled"],
        "interval_hours": cfg["interval_hours"],
        "retention_days": cfg["retention_days"],
        "interval_min": backends.INTERVAL_MIN_HOURS,
        "interval_max": backends.INTERVAL_MAX_HOURS,
        "retention_min": backends.RETENTION_MIN_DAYS,
        "retention_max": backends.RETENTION_MAX_DAYS,
        "prefix": backends.BACKUP_PREFIX,
        "directory": backends.backup_dir(),
        "share_dir": backends.share_dir(),
        "last_success": last,
        "next_run": nxt,
        "last_error": state.get("last_error") or "",
        "count": len(items),
        "backups": [
            {"name": b["name"], "size": b["size"], "mtime": b["mtime"]} for b in items
        ],
    }


def backup_thread():
    time.sleep(15)
    while True:
        try:
            run_auto_backup()
        except Exception as exc:
            log("auto backup loop error: %r" % (exc,))
        time.sleep(300)


# --------------------------------------------------------------------------
# request handler
# --------------------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    server_version = "qbpanel/" + VERSION
    protocol_version = "HTTP/1.0"

    # -- plumbing ---------------------------------------------------------
    def log_message(self, fmt, *args):
        if os.environ.get("QBPANEL_DEBUG"):
            log("%s - %s" % (self.address_string(), fmt % args))

    def read_body(self):
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            n = 0
        if n <= 0:
            return b""
        if n > 512 * 1024 * 1024:
            return b""
        buf = b""
        remaining = n
        while remaining > 0:
            chunk = self.rfile.read(min(remaining, 1 << 20))
            if not chunk:
                break
            buf += chunk
            remaining -= len(chunk)
        return buf

    def json_body(self):
        raw = self.read_body()
        if not raw:
            return {}
        try:
            d = json.loads(raw.decode("utf-8"))
            return d if isinstance(d, dict) else {}
        except Exception:
            return {}

    def send_payload(self, status, body=b"", ctype="application/json; charset=utf-8", extra=None):
        if isinstance(body, str):
            body = body.encode("utf-8")
        try:
            self.send_response(status)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            if self.command != "HEAD" and body:
                self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def send_json(self, obj, status=200):
        self.send_payload(status, json.dumps(obj, ensure_ascii=False))

    def fail(self, status, message, **extra):
        payload = {"ok": False, "error": message}
        payload.update(extra)
        self.send_json(payload, status)

    # -- routing ----------------------------------------------------------
    def do_GET(self):
        self.route("GET")

    def do_HEAD(self):
        self.route("HEAD")

    def do_POST(self):
        self.route("POST")

    def do_PUT(self):
        self.route("PUT")

    def do_DELETE(self):
        self.route("DELETE")

    def do_OPTIONS(self):
        self.send_payload(
            204,
            b"",
            extra={
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
                "Access-Control-Allow-Headers": "Content-Type,X-QBP-Server",
            },
        )

    def route(self, method):
        parsed = urllib.parse.urlsplit(self.path)
        path = urllib.parse.unquote(parsed.path)
        query = parsed.query

        try:
            if path.startswith("/api/"):
                self.handle_api(method, path, query)
            else:
                if method not in ("GET", "HEAD"):
                    self.fail(405, "method not allowed")
                    return
                self.serve_static(path)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as exc:  # pragma: no cover - defensive
            log("handler error on %s %s: %r" % (method, path, exc))
            try:
                self.fail(500, "internal error: %r" % (exc,))
            except Exception:
                pass

    # -- API --------------------------------------------------------------
    def handle_api(self, method, path, query):
        qs = urllib.parse.parse_qs(query)

        if path == "/api/health":
            self.send_json(
                {
                    "ok": True,
                    "app": APP_NAME,
                    "version": VERSION,
                    "python": sys.version.split()[0],
                    "var_dir": var_dir(),
                    "uptime": int(time.time() - START_TIME),
                }
            )
            return

        if path == "/api/config":
            if method == "GET":
                self.send_json(
                    {
                        "ok": True,
                        "settings": STORE.data.get("settings") or {},
                        "servers": [public_server(s) for s in STORE.servers()],
                        "current": (STORE.current() or {}).get("id", ""),
                        "app_version": VERSION,
                    }
                )
            elif method in ("POST", "PUT"):
                body = self.json_body()
                settings = body.get("settings")
                if isinstance(settings, dict):
                    STORE.update_settings(settings)
                self.send_json({"ok": True, "settings": STORE.data.get("settings") or {}})
            else:
                self.fail(405, "method not allowed")
            return

        if path == "/api/servers":
            if method == "GET":
                self.send_json({"ok": True, "servers": [public_server(s) for s in STORE.servers()]})
            elif method == "POST":
                self.upsert_server()
            else:
                self.fail(405, "method not allowed")
            return

        m = re.match(r"^/api/servers/([^/]+)$", path)
        if m:
            sid = m.group(1)
            if method == "POST" or method == "PUT":
                self.upsert_server(sid)
            elif method == "DELETE":
                STORE.delete_server(sid)
                self.send_json({"ok": True})
            else:
                self.fail(405, "method not allowed")
            return

        m = re.match(r"^/api/servers/([^/]+)/test$", path)
        if m and method == "POST":
            sid = m.group(1)
            body = self.json_body()
            saved = STORE.server(sid)
            if saved:
                srv = dict(saved)
                srv.update({k: v for k, v in body.items()
                            if k in ("url", "username", "kind", "verify_ssl")})
                if body.get("password"):
                    srv["password"] = body["password"]
                res = client_for(srv).test()
            else:
                # The add dialog lets you test before saving, so build a
                # throwaway client from the submitted form. Using the cache here
                # would key it under a bogus id and could echo stale credentials.
                srv = dict(body or {})
                srv.pop("id", None)
                if not (srv.get("url") or "").strip():
                    self.fail(400, "url is required")
                    return
                res = make_client(srv).test()
            self.send_json({"ok": bool(res.get("ok")), "result": res})
            return

        if path == "/api/current" and method == "POST":
            body = self.json_body()
            sid = body.get("id") or ""
            if sid and not STORE.server(sid):
                self.fail(404, "server not found")
                return
            with STORE._lock:
                STORE.data["current"] = sid
                STORE.save()
            self.send_json({"ok": True, "current": sid})
            return

        if path == "/api/upload":
            self.handle_upload(qs)
            return

        # ---------------- backups ----------------
        if path == "/api/backup/status":
            payload = {"ok": True}
            payload.update(backup_status())
            self.send_json(payload)
            return

        if path == "/api/backup/export":
            data = backends.make_backup(STORE, "manual")
            body = json.dumps(data, ensure_ascii=False, indent=2).encode("utf-8")
            name = backends.backup_filename(data.get("created_at"))
            # application/octet-stream, not json: Android WebView (the fnOS
            # phone app) consults the MIME type when deciding whether a
            # response is downloadable; json may render or be dropped even
            # with the attachment disposition, octet-stream always lands in
            # the download path.
            self.send_payload(200, body, "application/octet-stream", {
                "Content-Disposition": 'attachment; filename="%s"' % name,
            })
            return

        if path == "/api/backup/to-folder" and method == "POST":
            try:
                data = backends.make_backup(STORE, "manual")
                written = backends.write_backup(data)
                self.send_json({"ok": True, "path": written})
            except Exception as exc:
                self.fail(500, "export failed: %r" % (exc,))
            return

        if path == "/api/backup/run" and method == "POST":
            res = run_auto_backup(force=True)
            payload = {"ok": bool(res.get("ok"))}
            payload.update(res)
            self.send_json(payload, 200 if res.get("ok") else 500)
            return

        if path == "/api/backup/import" and method == "POST":
            raw = self.read_body()
            if not raw:
                self.fail(400, "empty backup")
                return
            try:
                data = backends.parse_backup(raw)
            except ValueError as exc:
                self.fail(400, "invalid backup: %s" % exc)
                return
            try:
                res = backends.apply_backup(STORE, data)
            except Exception as exc:
                self.fail(500, "import failed: %r" % (exc,))
                return
            reset_clients()
            self.send_json({"ok": True, "restored": res})
            return

        m = re.match(r"^/api/backup/(restore|delete)$", path)
        if m and method == "POST":
            body = self.json_body()
            safe = os.path.basename(body.get("name") or "")
            target = os.path.join(backends.backup_dir(), safe)
            if not safe.startswith(backends.BACKUP_PREFIX) or not os.path.isfile(target):
                self.fail(404, "backup not found")
                return
            if m.group(1) == "delete":
                try:
                    os.remove(target)
                    self.send_json({"ok": True})
                except OSError as exc:
                    self.fail(500, "delete failed: %r" % (exc,))
                return
            try:
                with open(target, "rb") as f:
                    data = backends.parse_backup(f.read())
                res = backends.apply_backup(STORE, data)
            except ValueError as exc:
                self.fail(400, "invalid backup: %s" % exc)
                return
            except Exception as exc:
                self.fail(500, "restore failed: %r" % (exc,))
                return
            reset_clients()
            self.send_json({"ok": True, "restored": res})
            return

        if path.startswith("/api/qb/"):
            self.handle_proxy(method, path[len("/api/qb/"):], query)
            return

        if path == "/api/proxy":
            target = (qs.get("p") or [""])[0]
            self.handle_proxy(method, target, "")
            return

        self.fail(404, "unknown api endpoint: %s" % path)

    def upsert_server(self, sid=None):
        body = self.json_body()
        if sid:
            body["id"] = sid
        existing = STORE.server(body.get("id")) if body.get("id") else None
        pw = body.get("password")
        if existing and (pw is None or pw == "" or pw == "__KEEP__"):
            body["password"] = existing.get("password") or ""
        if not (body.get("url") or "").strip():
            self.fail(400, "url is required")
            return
        # one entry per downloader - the same address added twice just creates
        # confusing duplicates in the switcher
        key = normalize_url(body.get("url"))
        for other in STORE.servers():
            if other.get("id") == body.get("id"):
                continue
            if normalize_url(other.get("url")) == key:
                self.fail(409, "duplicate server")
                return
        srv = STORE.upsert_server(body)
        self.send_json({"ok": True, "server": public_server(srv)})

    # -- torrent file upload (raw body) -----------------------------------
    def handle_upload(self, qs):
        raw = self.read_body()
        if not raw:
            self.fail(400, "empty file")
            return
        srv = STORE.current()
        if not srv:
            self.fail(400, "no server configured")
            return
        filename = (qs.get("filename") or ["upload.torrent"])[0]
        savepath = (qs.get("savepath") or [""])[0]
        category = (qs.get("category") or [""])[0]
        tags = (qs.get("tags") or [""])[0]
        paused = (qs.get("paused") or ["false"])[0]
        cli = client_for(srv)

        if isinstance(cli, TRClient):
            res = cli.rpc(
                "torrent-add",
                {
                    "metainfo": base64.b64encode(raw).decode("ascii"),
                    "download-dir": savepath or None,
                    "paused": paused.lower() == "true",
                },
            )
            ok = res.status == 200
            self.send_json({"ok": ok, "status": res.status, "body": res.text[:400]}, 200 if ok else 502)
            return

        boundary = "----qbpanel%s" % os.urandom(8).hex()
        parts = []
        fields = {"savepath": savepath, "category": category, "tags": tags, "paused": paused}
        for name, value in fields.items():
            if value == "" and name != "paused":
                continue
            parts.append(
                ('--%s\r\nContent-Disposition: form-data; name="%s"\r\n\r\n%s\r\n' % (boundary, name, value)).encode("utf-8")
            )
        parts.append(
            (
                '--%s\r\nContent-Disposition: form-data; name="torrents"; filename="%s"\r\n'
                "Content-Type: application/x-bittorrent\r\n\r\n" % (boundary, filename)
            ).encode("utf-8")
            + raw
            + b"\r\n"
        )
        parts.append(("--%s--\r\n" % boundary).encode("utf-8"))
        payload = b"".join(parts)

        res = cli.api(
            "POST",
            "/api/v2/torrents/add",
            payload,
            {"Content-Type": "multipart/form-data; boundary=%s" % boundary},
        )
        ok = res.status == 200
        self.send_json({"ok": ok, "status": res.status, "body": res.text[:400]}, 200 if ok else 502)

    # -- proxy ------------------------------------------------------------
    def handle_proxy(self, method, rest, query):
        srv = STORE.current()
        sid_header = self.headers.get("X-QBP-Server")
        if sid_header:
            srv = STORE.server(sid_header) or srv
        if not srv:
            self.fail(400, "no server configured")
            return
        cli = client_for(srv)

        if isinstance(cli, TRClient):
            self.proxy_transmission(method, cli, rest, query)
            return

        base = "/" + rest
        suffix = ("?" + query) if query else ""
        body = self.read_body()
        headers = {}
        ct = self.headers.get("Content-Type")
        if ct:
            headers["Content-Type"] = ct
        res = cli.api(method, base + suffix, body if body else None, headers)
        if res.status == 404:
            for alt in QB_ALIASES.get(base, ()):
                res = cli.api(method, alt + suffix, body if body else None, headers)
                if res.status != 404:
                    break
        self.relay(res)

    def relay(self, res):
        if res.status == 0:
            self.fail(502, res.error or "upstream unreachable")
            return
        ctype = res.headers.get("Content-Type") if res.headers else None
        self.send_payload(res.status, res.body, ctype or "application/json; charset=utf-8")

    # -- transmission translation -----------------------------------------
    def proxy_transmission(self, method, cli, rest, query):
        qs = urllib.parse.parse_qs(query)
        body_raw = self.read_body()
        form = urllib.parse.parse_qs(body_raw.decode("utf-8", "replace")) if body_raw else {}

        def arg(name, default=""):
            if name in qs:
                return qs[name][0]
            if name in form:
                return form[name][0]
            return default

        hashes = [h for h in (arg("hashes") or "all").split("|") if h and h != "all"]
        ids = [int(h) for h in hashes if h.isdigit()] if hashes else []

        def target_args():
            if ids:
                return {"ids": ids}
            return {}

        if rest == "api/v2/app/version":
            data, _ = cli.json_rpc("session-get")
            ver = (data or {}).get("arguments", {}).get("version", "")
            self.send_payload(200, json.dumps("Transmission %s" % ver), "application/json")
            return

        if rest == "api/v2/app/webapiVersion":
            self.send_payload(200, json.dumps("2.8.3"), "application/json")
            return

        if rest == "api/v2/torrents/info":
            items = cli.torrents_info()
            if items is None:
                self.fail(502, "transmission unreachable")
                return
            flt = arg("filter", "all")
            if flt == "downloading":
                items = [t for t in items if t["state"] in ("downloading", "stalledDL", "checkingDL")]
            elif flt == "seeding":
                items = [t for t in items if t["state"] in ("seeding", "stalledUP", "checkingUP")]
            elif flt == "paused":
                items = [t for t in items if t["state"] == "stopped"]
            elif flt == "completed":
                items = [t for t in items if t["progress"] >= 1]
            h = arg("hashes")
            if h and h != "all":
                want = set(h.split("|"))
                items = [t for t in items if t["hash"] in want]
            self.send_payload(200, json.dumps(items, ensure_ascii=False), "application/json")
            return

        if rest == "api/v2/transfer/info":
            data, _ = cli.json_rpc("session-stats")
            st = (data or {}).get("arguments", {})
            self.send_payload(
                200,
                json.dumps(
                    {
                        "connection_status": "connected",
                        "dl_info_speed": st.get("downloadSpeed", 0),
                        "up_info_speed": st.get("uploadSpeed", 0),
                        "dl_info_data": st.get("cumulative-stats", {}).get("downloadedBytes", 0),
                        "up_info_data": st.get("cumulative-stats", {}).get("uploadedBytes", 0),
                        "dl_rate_limit": 0,
                        "up_rate_limit": 0,
                        "dht_nodes": st.get("activeTorrentCount", 0),
                    }
                ),
            )
            return

        if rest == "api/v2/sync/maindata":
            items = cli.torrents_info() or []
            data, _ = cli.json_rpc("session-stats")
            st = (data or {}).get("arguments", {})
            torrents = {}
            for t in items:
                hash_ = t["hash"]
                torrents[hash_] = {
                    "name": t["name"],
                    "size": t["size"],
                    "progress": t["progress"],
                    "dlspeed": t["dlspeed"],
                    "upspeed": t["upspeed"],
                    "state": t["state"],
                    "eta": t["eta"],
                    "ratio": t["ratio"],
                    "category": t["category"],
                    "tags": t["tags"],
                    "num_seeds": t["num_seeds"],
                    "num_leechs": t["num_leechs"],
                    "downloaded": t["downloaded"],
                    "uploaded": t["uploaded"],
                    "save_path": t["save_path"],
                    "added_on": t["added_on"],
                    "completion_on": t["completion_on"],
                    "priority": t["priority"],
                    "seq_dl": t["seq_dl"],
                    "error": t["error"],
                }
            self.send_payload(
                200,
                json.dumps(
                    {
                        "rid": int(time.time()),
                        "torrents": torrents,
                        "removed": [],
                        "server_state": {
                            "dl_info_speed": st.get("downloadSpeed", 0),
                            "up_info_speed": st.get("uploadSpeed", 0),
                            "dl_info_data": st.get("cumulative-stats", {}).get("downloadedBytes", 0),
                            "up_info_data": st.get("cumulative-stats", {}).get("uploadedBytes", 0),
                            "alltime_dl": st.get("cumulative-stats", {}).get("downloadedBytes", 0),
                            "alltime_ul": st.get("cumulative-stats", {}).get("uploadedBytes", 0),
                            "connection_status": "connected",
                            "free_space_on_disk": 0,
                        },
                        "categories": {},
                        "tags": [],
                    },
                    ensure_ascii=False,
                ),
                "application/json",
            )
            return

        if rest in ("api/v2/torrents/pause", "api/v2/torrents/stop"):
            res = cli.rpc("torrent-stop", target_args())
            self.send_payload(200 if res.status == 200 else 502, b"")
            return

        if rest in ("api/v2/torrents/resume", "api/v2/torrents/start"):
            res = cli.rpc("torrent-start", target_args())
            self.send_payload(200 if res.status == 200 else 502, b"")
            return

        if rest == "api/v2/torrents/recheck":
            res = cli.rpc("torrent-verify", target_args())
            self.send_payload(200 if res.status == 200 else 502, b"")
            return

        if rest == "api/v2/torrents/delete":
            delete_files = arg("deleteFiles", "false").lower() == "true"
            res = cli.rpc("torrent-remove", dict(target_args(), **{"delete-local-data": delete_files}))
            self.send_payload(200 if res.status == 200 else 502, b"")
            return

        if rest == "api/v2/torrents/add":
            payload = {"paused": arg("paused", "false").lower() == "true"}
            urls = arg("urls")
            if urls:
                payload["filename"] = urls
            res = cli.rpc("torrent-add", payload)
            body = b"Ok." if res.status == 200 else b"Fail."
            self.send_payload(res.status if res.status else 502, body, "text/plain; charset=utf-8")
            return

        if rest == "api/v2/torrents/files":
            data, _ = cli.json_rpc("torrent-get", dict(target_args(), **{"fields": ["files", "id", "name"]}))
            files = []
            for t in (data or {}).get("arguments", {}).get("torrents", []):
                for f in t.get("files", []):
                    files.append(
                        {
                            "name": f.get("name"),
                            "size": f.get("length"),
                            "progress": f.get("bytesCompleted", 0) / max(f.get("length", 1), 1),
                            "priority": 0,
                            "is_seed": False,
                            "piece_range": [],
                        }
                    )
            self.send_payload(200, json.dumps(files, ensure_ascii=False), "application/json")
            return

        if rest == "api/v2/torrents/trackers":
            data, _ = cli.json_rpc("torrent-get", dict(target_args(), **{"fields": ["trackers", "trackerStats", "id"]}))
            out = []
            for t in (data or {}).get("arguments", {}).get("torrents", []):
                for tr in t.get("trackerStats", t.get("trackers", [])):
                    out.append(
                        {
                            "url": tr.get("announce") or tr.get("host") or "",
                            "status": 2,
                            "tier": tr.get("tier", 0),
                            "num_peers": tr.get("lastAnnouncePeerCount", 0),
                            "msg": tr.get("lastAnnounceResult") or "",
                        }
                    )
            self.send_payload(200, json.dumps(out, ensure_ascii=False), "application/json")
            return

        if rest == "api/v2/torrents/properties":
            data, _ = cli.json_rpc(
                "torrent-get",
                dict(
                    target_args(),
                    **{
                        "fields": [
                            "hashString", "name", "totalSize", "sizeWhenDone", "percentDone",
                            "downloadDir", "addedDate", "doneDate", "rateDownload", "rateUpload",
                            "uploadedEver", "downloadedEver", "eta", "uploadRatio", "status",
                            "peersConnected", "peersSendingToUs", "peersGettingFromUs", "comment",
                            "creator", "dateCreated", "pieceCount", "pieceSize", "isPrivate",
                            "secondsDownloading", "secondsSeeding", "error", "errorString",
                        ]
                    },
                ),
            )
            ts = (data or {}).get("arguments", {}).get("torrents", [])
            if not ts:
                self.fail(404, "not found")
                return
            t = ts[0]
            self.send_payload(
                200,
                json.dumps(
                    {
                        "hash": t.get("hashString"),
                        "name": t.get("name"),
                        "total_size": t.get("totalSize"),
                        "total_wasted": 0,
                        "save_path": t.get("downloadDir"),
                        "creation_date": t.get("dateCreated") or 0,
                        "comment": t.get("comment") or "",
                        "created_by": t.get("creator") or "",
                        "piece_size": t.get("pieceSize"),
                        "pieces_have": int((t.get("percentDone") or 0) * (t.get("pieceCount") or 0)),
                        "pieces_num": t.get("pieceCount"),
                        "dl_speed": t.get("rateDownload"),
                        "up_speed": t.get("rateUpload"),
                        "dl_speed_avg": 0,
                        "up_speed_avg": 0,
                        "eta": t.get("eta") if t.get("eta") not in (-1, -2) else 8640000,
                        "seeds": t.get("peersSendingToUs"),
                        "peers": t.get("peersGettingFromUs"),
                        "connections": t.get("peersConnected"),
                        "time_elapsed": (t.get("secondsDownloading") or 0) + (t.get("secondsSeeding") or 0),
                        "seeding_time": t.get("secondsSeeding") or 0,
                        "share_ratio": t.get("uploadRatio") if t.get("uploadRatio") not in (-1, -2) else 0,
                        "added_on": t.get("addedDate"),
                        "completion_on": t.get("doneDate"),
                        "is_private": bool(t.get("isPrivate")),
                        "state": "downloading" if not t.get("doneDate") else "seeding",
                    },
                    ensure_ascii=False,
                ),
                "application/json",
            )
            return

        if rest == "api/v2/log/main":
            data, _ = cli.json_rpc("session-get")
            self.send_payload(200, json.dumps([], ensure_ascii=False), "application/json")
            return

        if rest == "api/v2/torrents/categories":
            self.send_payload(200, json.dumps({}, ensure_ascii=False), "application/json")
            return

        if rest == "api/v2/torrents/tags":
            self.send_payload(200, json.dumps([], ensure_ascii=False), "application/json")
            return

        if rest == "api/v2/torrents/peers":
            self.send_payload(200, json.dumps({"peers": {}, "rid": 0}, ensure_ascii=False), "application/json")
            return

        if rest == "api/v2/app/preferences":
            self.send_payload(200, json.dumps({}, ensure_ascii=False), "application/json")
            return

        self.fail(501, "not implemented for transmission: %s" % rest)

    # -- static -----------------------------------------------------------
    def serve_static(self, path):
        root = os.path.abspath(web_dir())
        rel = path.lstrip("/") or "index.html"
        target = os.path.abspath(os.path.join(root, rel))
        if not (target == root or target.startswith(root + os.sep)):
            self.fail(403, "forbidden")
            return
        if os.path.isdir(target):
            target = os.path.join(target, "index.html")
        if not os.path.isfile(target):
            # SPA fallback
            index = os.path.join(root, "index.html")
            if os.path.isfile(index):
                self.send_file(index)
            else:
                self.fail(404, "not found: %s" % rel)
            return
        self.send_file(target)

    def send_file(self, target):
        try:
            with open(target, "rb") as f:
                data = f.read()
        except OSError as exc:
            self.fail(404, "cannot read file: %r" % (exc,))
            return
        ctype = guess_type(target)
        cache = "no-cache"
        if "/lib/" in target.replace("\\", "/"):
            cache = "public, max-age=86400"
        self.send_payload(200, data, ctype, {"Cache-Control": cache})


START_TIME = time.time()


def pick_port():
    for key in ("wizard_backend_port", "BACKEND_PORT", "QBPANEL_PORT", "PORT"):
        v = os.environ.get(key)
        if v and v.strip().isdigit():
            return int(v.strip())
    return 8898


def pick_host():
    v = os.environ.get("QBPANEL_LISTEN") or os.environ.get("wizard_listen_addr")
    if v:
        return v.strip()
    return "0.0.0.0"


def main():
    global STORE
    STORE = Store()
    port = pick_port()
    host = pick_host()
    httpd = ThreadingHTTPServer((host, port), Handler)
    httpd.daemon_threads = True
    httpd.allow_reuse_address = True
    threading.Thread(target=backup_thread, daemon=True).start()
    log("qbpanel %s listening on %s:%d (web=%s var=%s share=%s)" % (
        VERSION, host, port, web_dir(), var_dir(), backends.share_dir() or "-"))
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
