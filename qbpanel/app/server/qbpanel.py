#!/usr/bin/env python3
"""qbpanel : a fnOS native BitTorrent control panel.

Pure Python 3 standard library. Serves the web UI, stores configuration in
$TRIM_PKGVAR and reverse-proxies requests to the configured
qBittorrent / Transmission instance so the browser never needs direct access
to the downloader and its credentials stay server side.

A background worker watches the download queue so finished torrents can raise
notifications, and the maintenance section can install a newer package on
request (the installer runs detached from this process).
"""
import base64
import json
import mimetypes
import os
import re
import socket
import ssl
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from html import unescape as html_unescape
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import backends  # noqa: E402
import notify  # noqa: E402
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
# release check
#
# Reads the project's published releases and compares the tag against the
# running VERSION. Three paths, tried in order:
#   1. the REST API (rich payload: notes + asset list)
#   2. the releases Atom feed (no rate limit, notes as escaped HTML)
#   3. the "expanded assets" HTML fragment for the tag (download links)
# The API allows only 60 anonymous calls per hour per IP, and a busy home
# network can burn through that - 403 from step 1 is therefore treated as
# "try the feed", not as a failure.
# --------------------------------------------------------------------------
RELEASE_API = "https://api.github.com"
RELEASE_WEB = "https://github.com"
RELEASE_REPO = "Smi13zZ/qbpanel"
RELEASE_TTL = 900
RELEASE_CACHE = {"at": 0.0, "payload": None}
RELEASE_FAIL = {"at": 0.0, "payload": None}
RELEASE_LOCK = threading.Lock()


def version_tuple(value):
    """'v26.10.21' -> (26, 10, 21, 0) so plain tuple comparison orders builds."""
    nums = [int(p) for p in re.findall(r"\d+", str(value or ""))[:4]]
    while len(nums) < 4:
        nums.append(0)
    return tuple(nums)


def release_settings():
    st = (STORE.data.get("settings") or {}) if STORE else {}
    repo = str(st.get("update_repo") or RELEASE_REPO).strip().strip("/") or RELEASE_REPO
    base = str(st.get("update_api_base") or RELEASE_API).strip().rstrip("/") or RELEASE_API
    return repo, base


def describe_error(exc):
    if isinstance(exc, urllib.error.HTTPError):
        if exc.code == 403:
            return "HTTP 403（GitHub 接口限流）"
        if exc.code == 404:
            return "HTTP 404（仓库或发布不存在）"
        return "HTTP %d" % exc.code
    if isinstance(exc, urllib.error.URLError):
        reason = getattr(exc, "reason", None) or exc
        if isinstance(reason, socket.timeout):
            return "请求超时"
        return str(reason)
    if isinstance(exc, socket.timeout):
        return "请求超时"
    return str(exc) or exc.__class__.__name__


def http_get(url, timeout=8, accept=None):
    headers = {"User-Agent": "qBpanel/" + VERSION}
    if accept:
        headers["Accept"] = accept
    req = urllib.request.Request(url, headers=headers)
    ctx = ssl.create_default_context()
    with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
        return resp.read().decode("utf-8", "replace")


def strip_html(raw):
    """Atom feeds carry escaped HTML - flatten it to readable plain text."""
    text = html_unescape(raw or "")
    text = re.sub(r"<br\s*/?>", "\n", text, flags=re.I)
    text = re.sub(r"</(p|div|li|h[1-6])>", "\n", text, flags=re.I)
    text = re.sub(r"<li[^>]*>", "· ", text, flags=re.I)
    text = re.sub(r"<[^>]+>", "", text)
    text = html_unescape(text)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def release_from_api(repo, base):
    raw = http_get("%s/repos/%s/releases/latest" % (base, repo), accept="application/vnd.github+json")
    rel = json.loads(raw)
    tag = str(rel.get("tag_name") or rel.get("name") or "").strip()
    return {
        "tag": tag,
        "name": str(rel.get("name") or tag),
        "notes": str(rel.get("body") or ""),
        "published_at": str(rel.get("published_at") or ""),
        "html_url": str(rel.get("html_url") or ""),
        "assets": [
            {
                "name": str(a.get("name") or ""),
                "size": int(a.get("size") or 0),
                "url": str(a.get("browser_download_url") or ""),
            }
            for a in (rel.get("assets") or [])
            if a.get("browser_download_url")
        ],
        "source": "api",
    }


def release_from_atom(repo):
    xml = http_get("%s/%s/releases.atom" % (RELEASE_WEB, repo))
    entry = re.search(r"<entry>(.*?)</entry>", xml, re.S)
    if not entry:
        raise ValueError("发布订阅源里没有条目")
    block = entry.group(1)
    title = re.search(r"<title>(.*?)</title>", block, re.S)
    link = re.search(r'<link[^>]+rel="alternate"[^>]+href="([^"]+)"', block)
    updated = re.search(r"<updated>(.*?)</updated>", block, re.S)
    body = re.search(r"<content[^>]*>(.*?)</content>", block, re.S)
    url = html_unescape(link.group(1)) if link else ""
    tag = ""
    m = re.search(r"/tag/([^/]+)$", url)
    if m:
        tag = m.group(1)
    if not tag and title:
        m = re.search(r"(v?\d+(?:\.\d+)+)", title.group(1))
        tag = m.group(1) if m else ""
    return {
        "tag": tag,
        "name": html_unescape(strip_html(title.group(1))) if title else tag,
        "notes": strip_html(body.group(1)) if body else "",
        "published_at": updated.group(1) if updated else "",
        "html_url": url,
        "assets": [],
        "source": "atom",
    }


def assets_from_html(repo, tag):
    """The release page renders its asset list in a separate fragment - no API
    quota involved, which is what makes one-click update work while rate limited."""
    if not tag:
        return []
    page = http_get("%s/%s/releases/expanded_assets/%s" % (RELEASE_WEB, repo, urllib.parse.quote(tag)))
    out = []
    seen = set()
    # the visible name sits in a nested <span>, so take it from the URL itself
    for href in re.findall(r'href="(/[^"]+/releases/download/[^"]+)"', page):
        href = html_unescape(href)
        if href in seen:
            continue
        seen.add(href)
        name = urllib.parse.unquote(href.rsplit("/", 1)[-1])
        out.append({"name": name, "size": 0, "url": RELEASE_WEB + href})
    return out


def check_update(force=False):
    repo, base = release_settings()
    now = time.time()
    with RELEASE_LOCK:
        cached = RELEASE_CACHE["payload"]
        if not force and cached and now - RELEASE_CACHE["at"] < RELEASE_TTL:
            out = dict(cached)
            out["cached"] = True
            return out
        # a failed lookup is cached for a minute: without this every page load
        # retried a rate-limited API and dug the hole deeper
        if not force and RELEASE_FAIL["payload"] and now - RELEASE_FAIL["at"] < 60:
            out = dict(RELEASE_FAIL["payload"])
            out["cached"] = True
            return out
    out = {
        "ok": True,
        "current": VERSION,
        "latest": "",
        "has_update": False,
        "name": "",
        "notes": "",
        "published_at": "",
        "html_url": "",
        "repo": repo,
        "assets": [],
        "checked_at": int(now),
        "cached": False,
        "source": "",
        "error": "",
    }
    rel = None
    first_error = ""
    try:
        rel = release_from_api(repo, base)
    except Exception as exc:
        first_error = describe_error(exc)
        log("release api failed (%s), falling back to the feed" % first_error)
    if rel is None:
        try:
            rel = release_from_atom(repo)
        except Exception as exc:
            out["ok"] = False
            out["error"] = first_error or describe_error(exc)
            log("release check failed: %s" % out["error"])
            with RELEASE_LOCK:
                RELEASE_FAIL["at"] = now
                RELEASE_FAIL["payload"] = dict(out)
            return out

    tag = (rel.get("tag") or "").strip()
    latest = tag[1:] if tag[:1] in ("v", "V") else tag
    out["latest"] = latest or tag
    out["name"] = rel.get("name") or tag
    out["notes"] = (rel.get("notes") or "")[:6000]
    out["published_at"] = rel.get("published_at") or ""
    out["html_url"] = rel.get("html_url") or ""
    out["source"] = rel.get("source") or ""
    assets = rel.get("assets") or []
    if not assets and latest:
        try:
            assets = assets_from_html(repo, tag or ("v" + latest))
        except Exception as exc:
            log("asset list unavailable: %s" % describe_error(exc))
    out["assets"] = assets
    out["has_update"] = bool(latest) and version_tuple(latest) > version_tuple(VERSION)
    with RELEASE_LOCK:
        RELEASE_CACHE["at"] = now
        RELEASE_CACHE["payload"] = dict(out)
    notify_update_event(out)
    return out


# --------------------------------------------------------------------------
# notifications
#
# Two event sources: a torrent leaving "downloading" (completion monitor) and a
# newer release appearing. Both fan out to the configured channels through
# notify.send(); a failure is logged per channel and never breaks the loop.
# --------------------------------------------------------------------------
NOTIFY_STATE_FILE = os.path.join(var_dir(), "notify-state.json")
NOTIFY_STATE_LOCK = threading.Lock()


def default_notify_settings():
    return {"enabled": False, "on_complete": True, "on_update": True, "channels": []}


def notify_settings():
    st = (STORE.data.get("settings") or {}) if STORE else {}
    raw = st.get("notify")
    cfg = default_notify_settings()
    if isinstance(raw, dict):
        cfg["enabled"] = bool(raw.get("enabled"))
        cfg["on_complete"] = bool(raw.get("on_complete", True))
        cfg["on_update"] = bool(raw.get("on_update", True))
        if isinstance(raw.get("channels"), list):
            cfg["channels"] = [c for c in raw["channels"] if isinstance(c, dict)]
    return cfg


def save_notify_settings(cfg):
    with STORE._lock:
        st = STORE.data.setdefault("settings", {})
        st["notify"] = cfg
        STORE.save()


def load_notify_state():
    try:
        with open(NOTIFY_STATE_FILE, "r", encoding="utf-8") as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def save_notify_state(state):
    try:
        tmp = NOTIFY_STATE_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(state, f)
        os.replace(tmp, NOTIFY_STATE_FILE)
    except Exception as exc:
        log("notify state save failed: %r" % (exc,))


# --------------------------------------------------------------------------
# delivery records
#
# Every attempt - the two automatic events and the "test" button - is written
# here, so the settings page can answer "did it really go out, and what was in
# it?" without digging through the service log. Newest first, ring buffered.
# --------------------------------------------------------------------------
NOTIFY_LOG_FILE = os.path.join(var_dir(), "notify-log.json")
NOTIFY_LOG_LOCK = threading.Lock()
NOTIFY_LOG_MAX = 200
NOTIFY_LOG_BODY = 600


def load_notify_log():
    try:
        with open(NOTIFY_LOG_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        return []
    recs = data.get("records") if isinstance(data, dict) else data
    if not isinstance(recs, list):
        return []
    return [r for r in recs if isinstance(r, dict)]


def save_notify_log(records):
    try:
        tmp = NOTIFY_LOG_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"records": records}, f, ensure_ascii=False)
        os.replace(tmp, NOTIFY_LOG_FILE)
    except Exception as exc:
        log("notify log save failed: %r" % (exc,))


def clear_notify_log():
    with NOTIFY_LOG_LOCK:
        save_notify_log([])


def record_delivery(channel, title, body, event, res):
    """Append one delivery attempt. The message body is kept - that is the
    whole point of the record - but channel secrets never are: they live in
    config.json only."""
    rec = {
        "id": uuid.uuid4().hex[:12],
        "at": int(time.time()),
        "event": event or "manual",
        "channel": channel.get("name") or channel.get("type") or "",
        "channel_id": channel.get("id") or "",
        "type": channel.get("type") or "",
        "ok": bool(res.get("ok")),
        "detail": str(res.get("detail") or "")[:300],
        "title": str(title or "")[:200],
        "body": str(body or "")[:NOTIFY_LOG_BODY],
    }
    with NOTIFY_LOG_LOCK:
        recs = load_notify_log()
        recs.insert(0, rec)
        if len(recs) > NOTIFY_LOG_MAX:
            del recs[NOTIFY_LOG_MAX:]
        save_notify_log(recs)
    return rec


def dispatch(title, body, event=""):
    """Fan a message out to every enabled channel."""
    cfg = notify_settings()
    results = []
    if not cfg["enabled"]:
        return results
    for ch in cfg["channels"]:
        if not ch.get("enabled", True):
            continue
        res = notify.send(ch, title, body)
        record_delivery(ch, title, body, event, res)
        results.append({
            "id": ch.get("id") or "",
            "name": ch.get("name") or ch.get("type") or "",
            "ok": bool(res.get("ok")),
            "detail": res.get("detail") or "",
        })
        if not res.get("ok"):
            log("notify[%s] failed: %s" % (ch.get("name"), res.get("detail")))
    return results


def notify_update_event(info):
    """Announce a release once - repeated checks for the same tag stay silent."""
    cfg = notify_settings()
    if not (cfg["enabled"] and cfg["on_update"]):
        return
    latest = (info or {}).get("latest") or ""
    if not latest or not info.get("has_update"):
        return
    with NOTIFY_STATE_LOCK:
        state = load_notify_state()
        if state.get("last_update_notified") == latest:
            return
        state["last_update_notified"] = latest
        save_notify_state(state)
    dispatch(
        "qBpanel %s 可用" % latest,
        "当前 v%s，可在面板「设置 → 更新」里一键升级。" % VERSION,
        event="update",
    )


def torrents_snapshot():
    srv = STORE.current()
    if not srv:
        return []
    cli = client_for(srv)
    if isinstance(cli, TRClient):
        return cli.torrents_info() or []
    res = cli.api("GET", "/api/v2/torrents/info")
    if res.status != 200:
        return []
    try:
        data = json.loads(res.text)
    except Exception:
        return []
    return data if isinstance(data, list) else []


def human_size(num):
    try:
        num = float(num or 0)
    except (TypeError, ValueError):
        return "-"
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if num < 1024 or unit == "TB":
            return ("%d %s" % (num, unit)) if unit == "B" else ("%.2f %s" % (num, unit))
        num /= 1024.0
    return "-"


def poll_completions():
    """Notify on the transition to 100% - torrents that were already complete
    when the monitor started are recorded silently (no burst on first run)."""
    cfg = notify_settings()
    if not (cfg["enabled"] and cfg["on_complete"]):
        return
    items = torrents_snapshot()
    if not items:
        return
    with NOTIFY_STATE_LOCK:
        state = load_notify_state()
        done = state.get("done") or {}
        seen = state.get("seen") or {}
        changed = False
        for t in items:
            h = str(t.get("hash") or "")
            if not h or h in done:
                continue
            if h not in seen:
                # first sighting: remember it, but never notify yet
                seen[h] = 1
                changed = True
                if float(t.get("progress") or 0) >= 0.999:
                    done[h] = int(time.time())
                continue
            if float(t.get("progress") or 0) >= 0.999:
                name = str(t.get("name") or h)
                size = human_size(t.get("size") or t.get("total_size"))
                path = str(t.get("save_path") or t.get("download_dir") or "")
                dispatch(
                    "下载完成：%s" % name,
                    "%s\n%s" % (size, path) if path else size,
                    event="complete",
                )
                done[h] = int(time.time())
                seen.pop(h, None)
                changed = True
        if changed and len(done) > 500:
            for k in sorted(done, key=lambda x: done[x])[:-400]:
                done.pop(k, None)
        if changed:
            state["done"] = done
            state["seen"] = seen
            save_notify_state(state)


def notify_thread():
    time.sleep(25)
    while True:
        try:
            poll_completions()
        except Exception as exc:
            log("notify loop error: %r" % (exc,))
        time.sleep(30)


# --------------------------------------------------------------------------
# one-click update
#
# fnOS refuses to upgrade an installed app through install-fpk, so the update
# is uninstall + install. That has to outlive this process, hence the detached
# shell script; the package is validated and the previous one kept as a
# rollback before anything is uninstalled.
# --------------------------------------------------------------------------
UPDATE_DIR = os.path.join(var_dir(), "update")
UPDATE_STATE = {"phase": "idle", "version": "", "detail": "", "at": 0}
UPDATE_LOCK = threading.Lock()


def _set_update(phase, version="", detail=""):
    with UPDATE_LOCK:
        UPDATE_STATE.update({
            "phase": phase,
            "version": version,
            "detail": detail,
            "at": int(time.time()),
        })


def update_status():
    st = dict(UPDATE_STATE)
    st["current"] = VERSION
    log_path = os.path.join(UPDATE_DIR, "install.log")
    st["log"] = ""
    if os.path.isfile(log_path):
        try:
            with open(log_path, "r", encoding="utf-8", errors="replace") as f:
                lines = f.read().strip().splitlines()
            st["log"] = "\n".join(lines[-12:])
        except Exception:
            pass
    return st


def pick_fpk_asset(info):
    assets = info.get("assets") or []
    fpks = [a for a in assets if str(a.get("name") or "").lower().endswith(".fpk")]
    for a in fpks:
        if "-all" in a["name"]:
            return a
    return fpks[0] if fpks else None


def download_file(url, dest, limit=128 * 1024 * 1024):
    req = urllib.request.Request(url, headers={"User-Agent": "qBpanel/" + VERSION})
    ctx = ssl.create_default_context()
    total = 0
    with urllib.request.urlopen(req, timeout=180, context=ctx) as resp, open(dest, "wb") as f:
        while True:
            chunk = resp.read(256 * 1024)
            if not chunk:
                break
            total += len(chunk)
            if total > limit:
                raise ValueError("安装包超过 %d MB，已中止" % (limit // 1024 // 1024))
            f.write(chunk)
    return total


def validate_fpk(path):
    """Refuse to uninstall anything unless the package is a real, matching build."""
    import tarfile
    try:
        with tarfile.open(path, "r:gz") as tf:
            names = tf.getnames()
            if "manifest" not in names or "app.tgz" not in names:
                raise ValueError("安装包结构不完整")
            raw = tf.extractfile("manifest").read().decode("utf-8", "replace")
    except ValueError:
        raise
    except Exception as exc:
        raise ValueError("安装包无法解压：%s" % exc)
    appname = ""
    for line in raw.splitlines():
        if line.strip().startswith("appname"):
            appname = line.split("=", 1)[1].strip()
            break
    if appname != APP_NAME:
        raise ValueError("安装包应用名不匹配：%s" % (appname or "?"))
    if not os.path.isfile("/usr/bin/appcenter-cli") and not shutil.which("appcenter-cli"):
        raise ValueError("找不到 appcenter-cli，无法自动安装")


def find_previous_fpk():
    """The package matching the running version, used as a rollback."""
    for folder in ("/vol1/1000/development/qbpanel", "/vol1/@appshare/fn-qbpanel"):
        try:
            for fn in os.listdir(folder):
                if fn.startswith("fn-qbpanel-%s" % VERSION) and fn.endswith(".fpk"):
                    return os.path.join(folder, fn)
        except OSError:
            continue
    return ""


UPDATE_SCRIPT = """#!/bin/sh
# One-click update helper. Detached from the panel process on purpose: the
# uninstall step stops the service, so a child of it would be killed too.
set -u
LOG="%(log)s"
exec >>"$LOG" 2>&1
echo "=== $(date '+%%F %%T') update to %(version)s ==="
sleep 2
APP=fn-qbpanel
ENVF=/tmp/qbp-update-env
printf 'wizard_backend_port=%%s\\n' '%(port)s' > "$ENVF"
appcenter-cli uninstall "$APP"
sleep 3
appcenter-cli install-fpk -e "$ENVF" "%(pkg)s"
appcenter-cli start "$APP"
sleep 9
if appcenter-cli status "$APP" | grep -qE 'running|starting'; then
  echo "=== update finished ==="
  exit 0
fi
echo "=== new package did not start ==="
if [ -n "%(prev)s" ] && [ -f "%(prev)s" ]; then
  echo "=== rolling back ==="
  appcenter-cli uninstall "$APP"
  sleep 3
  appcenter-cli install-fpk -e "$ENVF" "%(prev)s"
  appcenter-cli start "$APP"
fi
"""


def build_update_script(version, port, pkg, prev, log_path):
    return UPDATE_SCRIPT % {
        "log": log_path,
        "version": version,
        "port": port,
        "pkg": pkg,
        "prev": prev,
    }


def start_update():
    if UPDATE_STATE.get("phase") in ("downloading", "installing"):
        return {"ok": False, "error": "更新已在进行中"}
    info = check_update(force=True)
    if not info.get("ok"):
        return {"ok": False, "error": info.get("error") or "无法获取版本信息"}
    if not info.get("has_update"):
        return {"ok": False, "error": "当前已是最新版本", "latest": info.get("latest")}
    asset = pick_fpk_asset(info)
    if not asset:
        return {"ok": False, "error": "该版本没有附带 .fpk 安装包"}
    try:
        os.makedirs(UPDATE_DIR, exist_ok=True)
    except OSError as exc:
        return {"ok": False, "error": "无法创建下载目录：%s" % exc}
    name = os.path.basename(asset["name"]) or "qBpanel-update.fpk"
    dest = os.path.join(UPDATE_DIR, name)
    _set_update("downloading", info["latest"], "正在下载 %s" % name)
    try:
        download_file(asset["url"], dest)
        validate_fpk(dest)
    except Exception as exc:
        _set_update("failed", info["latest"], str(exc))
        log("update download failed: %r" % (exc,))
        return {"ok": False, "error": str(exc)}

    prev = ""
    try:
        src = find_previous_fpk()
        if src:
            prev = os.path.join(UPDATE_DIR, "rollback.fpk")
            shutil.copyfile(src, prev)
    except Exception as exc:
        log("rollback copy skipped: %r" % (exc,))
        prev = ""

    script = os.path.join(UPDATE_DIR, "install.sh")
    try:
        with open(script, "w", encoding="utf-8", newline="\n") as f:
            f.write(build_update_script(
                info["latest"], pick_port(), dest, prev,
                os.path.join(UPDATE_DIR, "install.log"),
            ))
        os.chmod(script, 0o755)
        # start_new_session detaches from this process group: the installer
        # stops the very service that spawned it, so it must survive the kill.
        subprocess.Popen(
            ["/bin/sh", script],
            cwd=UPDATE_DIR,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
    except Exception as exc:
        _set_update("failed", info["latest"], "无法启动安装脚本：%s" % exc)
        return {"ok": False, "error": "无法启动安装脚本：%s" % exc}
    _set_update("installing", info["latest"], "安装包已就绪，正在重启服务")
    log("one-click update started -> %s" % info["latest"])
    return {"ok": True, "version": info["latest"], "file": name}



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

        if path == "/api/update/check":
            flag = (qs.get("force") or ["0"])[0].lower()
            self.send_json(check_update(flag not in ("", "0", "false", "no")))
            return

        if path == "/api/update/install" and method == "POST":
            res = start_update()
            self.send_json(res, 200 if res.get("ok") else 400)
            return

        if path == "/api/update/status":
            payload = {"ok": True}
            payload.update(update_status())
            self.send_json(payload)
            return

        # ---------------- notifications ----------------
        if path == "/api/notify" and method == "GET":
            cfg = notify_settings()
            self.send_json({
                "ok": True,
                "settings": {
                    "enabled": cfg["enabled"],
                    "on_complete": cfg["on_complete"],
                    "on_update": cfg["on_update"],
                },
                "channels": [notify.channel_public(c) for c in cfg["channels"]],
                "types": list(notify.CHANNEL_TYPES.keys()),
            })
            return

        if path == "/api/notify/settings" and method == "POST":
            body = self.json_body()
            cfg = notify_settings()
            for key in ("enabled", "on_complete", "on_update"):
                if key in body:
                    cfg[key] = bool(body[key])
            save_notify_settings(cfg)
            self.send_json({"ok": True, "settings": {
                "enabled": cfg["enabled"],
                "on_complete": cfg["on_complete"],
                "on_update": cfg["on_update"],
            }})
            return

        if path == "/api/notify/channel" and method == "POST":
            body = self.json_body()
            ctype = (body.get("type") or "").strip()
            if ctype not in notify.CHANNEL_TYPES:
                self.fail(400, "unknown channel type")
                return
            cfg = notify_settings()
            cid = (body.get("id") or "").strip() or uuid.uuid4().hex[:12]
            old = None
            for c in cfg["channels"]:
                if c.get("id") == cid:
                    old = c
                    break
            ch = {
                "id": cid,
                "name": (body.get("name") or "").strip() or notify.CHANNEL_TYPES[ctype]["label_zh"],
                "type": ctype,
                "enabled": bool(body.get("enabled", True)),
                "config": notify.merge_config(ctype, body.get("config") or {}, (old or {}).get("config") or {}),
            }
            if old is None:
                cfg["channels"].append(ch)
            else:
                cfg["channels"] = [ch if c.get("id") == cid else c for c in cfg["channels"]]
            # first channel switches the feature on - adding one and getting
            # silence would be a confusing default
            if not cfg["enabled"] and len(cfg["channels"]) == 1:
                cfg["enabled"] = True
            save_notify_settings(cfg)
            self.send_json({
                "ok": True,
                "channel": notify.channel_public(ch),
                "settings": {
                    "enabled": cfg["enabled"],
                    "on_complete": cfg["on_complete"],
                    "on_update": cfg["on_update"],
                },
            })
            return

        m = re.match(r"^/api/notify/channel/([^/]+)$", path)
        if m and method == "DELETE":
            cid = m.group(1)
            cfg = notify_settings()
            cfg["channels"] = [c for c in cfg["channels"] if c.get("id") != cid]
            save_notify_settings(cfg)
            self.send_json({"ok": True})
            return

        if path == "/api/notify/test" and method == "POST":
            body = self.json_body()
            cid = (body.get("id") or "").strip()
            cfg = notify_settings()
            ch = None
            for c in cfg["channels"]:
                if c.get("id") == cid:
                    ch = c
                    break
            if not ch:
                self.fail(404, "channel not found")
                return
            title = "qBpanel 通知测试"
            body = "如果你收到这条消息，说明「%s」渠道配置正确。" % (ch.get("name") or ch.get("type"))
            res = notify.send(ch, title, body)
            record_delivery(ch, title, body, "test", res)
            self.send_json({"ok": bool(res.get("ok")), "result": res})
            return

        if path == "/api/notify/log" and method == "GET":
            try:
                limit = int((qs.get("limit") or ["50"])[0])
            except (TypeError, ValueError):
                limit = 50
            limit = max(1, min(limit, NOTIFY_LOG_MAX))
            recs = load_notify_log()
            self.send_json({
                "ok": True,
                "records": recs[:limit],
                "total": len(recs),
                "max": NOTIFY_LOG_MAX,
            })
            return

        if path == "/api/notify/log" and method == "DELETE":
            clear_notify_log()
            self.send_json({"ok": True})
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
    threading.Thread(target=notify_thread, daemon=True).start()
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
