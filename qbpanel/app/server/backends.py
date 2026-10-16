"""qbpanel : configuration store and BitTorrent client adapters.

Pure Python 3 standard library only - no third party dependencies.
Supports qBittorrent (WebAPI v2) natively and Transmission (RPC) through a
thin translation layer that exposes qBittorrent-shaped replies, so the web
front-end only ever talks one dialect.
"""
import glob
import json
import os
import re
import ssl
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

APP_NAME = "fn-qbpanel"
# Packages before 26.10.13 were named "qbpanel"; backup documents produced by
# them carry that app field, so the importer below still accepts it.
LEGACY_APP_NAMES = ("qbpanel",)
# cmd/main exports the version read from the fpk manifest, so the panel always
# reports the packaged version instead of a hand-maintained constant.
VERSION = os.environ.get("QBPANEL_VERSION") or "26.10.9"


# --------------------------------------------------------------------------
# paths
# --------------------------------------------------------------------------
def app_root():
    return os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))


def var_dir():
    d = os.environ.get("TRIM_PKGVAR")
    if not d:
        d = os.path.join(app_root(), "var")
    try:
        os.makedirs(d, exist_ok=True)
    except OSError:
        pass
    return d


def web_dir():
    for c in (os.path.join(app_root(), "web"), os.path.join(app_root(), "ui", "www")):
        if os.path.isdir(c):
            return c
    return os.path.join(app_root(), "web")


def log(msg):
    line = "[%s] %s" % (time.strftime("%Y-%m-%d %H:%M:%S"), msg)
    print(line, flush=True)
    try:
        with open(os.path.join(var_dir(), "qbpanel.log"), "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


# --------------------------------------------------------------------------
# configuration
# --------------------------------------------------------------------------
def default_config():
    return {
        "servers": [],
        "current": "",
        "settings": {
            "theme": "dark",
            "refresh_ms": 2000,
            "confirm_delete": True,
            "speed_unit": "auto",
            "auto_backup_enabled": False,
            "auto_backup_interval_hours": 24,
            "auto_backup_retention_days": 30,
        },
    }


class Store(object):
    def __init__(self, path=None):
        self.path = path or os.path.join(var_dir(), "config.json")
        self._lock = threading.RLock()
        self.data = default_config()
        self.load()

    def load(self):
        with self._lock:
            try:
                with open(self.path, "r", encoding="utf-8") as f:
                    raw = json.load(f)
                if isinstance(raw, dict):
                    base = default_config()
                    base.update(raw)
                    if not isinstance(base.get("settings"), dict):
                        base["settings"] = default_config()["settings"]
                    if not isinstance(base.get("servers"), list):
                        base["servers"] = []
                    self.data = base
            except FileNotFoundError:
                pass
            except Exception as exc:
                log("config load failed: %r" % (exc,))

    def save(self):
        with self._lock:
            tmp = self.path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(self.data, f, ensure_ascii=False, indent=2)
            os.replace(tmp, self.path)

    # -- servers -----------------------------------------------------------
    def servers(self):
        with self._lock:
            return list(self.data.get("servers") or [])

    def server(self, sid):
        for s in self.servers():
            if s.get("id") == sid:
                return s
        return None

    def current(self):
        with self._lock:
            sid = self.data.get("current") or ""
        srv = self.server(sid) if sid else None
        if srv is None:
            lst = self.servers()
            srv = lst[0] if lst else None
        return srv

    def upsert_server(self, payload):
        with self._lock:
            srv = dict(payload or {})
            sid = (srv.get("id") or "").strip()
            if not sid:
                sid = uuid.uuid4().hex[:12]
            srv["id"] = sid
            srv.setdefault("name", "qBittorrent")
            srv.setdefault("kind", "qbittorrent")
            srv["url"] = (srv.get("url") or "").strip().rstrip("/")
            lst = self.data.setdefault("servers", [])
            for i, old in enumerate(lst):
                if old.get("id") == sid:
                    merged = dict(old)
                    merged.update(srv)
                    lst[i] = merged
                    srv = merged
                    break
            else:
                lst.append(srv)
            if not self.data.get("current"):
                self.data["current"] = sid
            self.save()
            return srv

    def delete_server(self, sid):
        with self._lock:
            lst = [s for s in self.data.get("servers", []) if s.get("id") != sid]
            self.data["servers"] = lst
            if self.data.get("current") == sid:
                self.data["current"] = lst[0]["id"] if lst else ""
            self.save()

    def update_settings(self, patch):
        with self._lock:
            st = self.data.setdefault("settings", {})
            st.update(patch or {})
            self.save()
            return st


# --------------------------------------------------------------------------
# HTTP helper
# --------------------------------------------------------------------------
def _ctx(verify):
    if verify:
        return None
    return ssl._create_unverified_context()


class HeaderDict(dict):
    """Case-insensitive header lookup that merges repeated header values.

    http.client lower-cases response header names while some servers do not,
    and dict lookups are case sensitive - so `headers.get("Set-Cookie")` would
    silently miss a lower-cased `set-cookie`.
    """

    def __init__(self, items=None):
        super().__init__()
        self._map = {}
        if items is None:
            return
        iterator = items.items() if hasattr(items, "items") else items
        for k, v in iterator:
            self[k] = v

    def __setitem__(self, key, value):
        lk = str(key).lower()
        real = self._map.get(lk)
        if real is None:
            self._map[lk] = key
            super().__setitem__(key, value)
        else:
            super().__setitem__(real, "%s, %s" % (super().__getitem__(real), value))

    def __getitem__(self, key):
        lk = str(key).lower()
        if lk in self._map:
            return super().__getitem__(self._map[lk])
        return super().__getitem__(key)

    def __contains__(self, key):
        return str(key).lower() in self._map

    def get(self, key, default=None):
        real = self._map.get(str(key).lower())
        if real is None:
            return default
        return super().__getitem__(real)


class HttpResult(object):
    __slots__ = ("status", "headers", "body", "error")

    def __init__(self, status=0, headers=None, body=b"", error=None):
        self.status = status
        self.headers = headers if headers is not None else HeaderDict()
        self.body = body
        self.error = error

    @property
    def text(self):
        try:
            return self.body.decode("utf-8", "replace")
        except Exception:
            return ""


def http_call(url, method="GET", data=None, headers=None, timeout=25, verify=True):
    req = urllib.request.Request(url, data=data, method=method)
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=_ctx(verify)) as resp:
            return HttpResult(resp.status, HeaderDict(resp.headers.items()), resp.read())
    except urllib.error.HTTPError as exc:
        try:
            body = exc.read()
        except Exception:
            body = b""
        return HttpResult(exc.code, HeaderDict((exc.headers or {}).items()), body, "http %s" % exc.code)
    except Exception as exc:
        return HttpResult(0, HeaderDict(), b"", repr(exc))


def parse_sid_cookie(set_cookie):
    """qBittorrent 4.x uses `SID`, 5.x uses `QBT_SID_<port>`. Return (name, value)."""
    if not set_cookie:
        return None, None
    for m in re.finditer(r"([A-Za-z_][A-Za-z0-9_]*)=([^;,\s]+)", str(set_cookie)):
        name, value = m.group(1), m.group(2)
        if name == "SID" or name.startswith("QBT_SID"):
            return name, value
    return None, None


def cookie_value(set_cookie, name):
    """Kept for backwards compatibility - returns value of a named cookie."""
    if not set_cookie:
        return None
    for part in str(set_cookie).split(","):
        for chunk in part.split(";"):
            chunk = chunk.strip()
            if chunk.lower().startswith(name.lower() + "="):
                return chunk.split("=", 1)[1]
    return None


# --------------------------------------------------------------------------
# qBittorrent client
# --------------------------------------------------------------------------
class QBClient(object):
    kind = "qbittorrent"

    def __init__(self, server):
        self.server = server or {}
        self.url = (self.server.get("url") or "").strip().rstrip("/")
        self.username = self.server.get("username") or ""
        self.password = self.server.get("password") or ""
        self.verify = bool(self.server.get("verify_ssl", False))
        self._sid = None
        self._sid_name = "SID"
        self._auth_disabled = False
        self._lock = threading.RLock()
        self._last_login = 0.0

    def _headers(self):
        h = {"Referer": self.url or "http://localhost", "Accept": "application/json"}
        if self._sid:
            h["Cookie"] = "%s=%s" % (self._sid_name, self._sid)
        return h

    def login(self, force=False):
        with self._lock:
            now = time.time()
            if (self._sid or self._auth_disabled) and not force and now - self._last_login < 900:
                return True
            data = urllib.parse.urlencode(
                {"username": self.username, "password": self.password}
            ).encode("utf-8")
            headers = {
                "Referer": self.url or "http://localhost",
                "Content-Type": "application/x-www-form-urlencoded",
                "Origin": self.url or "http://localhost",
            }
            res = http_call(
                self.url + "/api/v2/auth/login",
                "POST",
                data,
                headers,
                timeout=15,
                verify=self.verify,
            )
            body = res.text.strip()
            # qBittorrent >= 4.6 answers 204 with an empty body on success and
            # sets QBT_SID_<port>; 4.x answers 200 "Ok." with a SID cookie.
            if res.status == 204 or body.lower().startswith("ok"):
                name, value = parse_sid_cookie(res.headers.get("Set-Cookie"))
                self._sid_name = name or "SID"
                self._sid = value or ""
                self._auth_disabled = not bool(value)
                self._last_login = now
                return True
            self._sid = None
            self._auth_disabled = False
            return False

    def raw(self, method, path, data=None, headers=None, timeout=30, _retry=True):
        if not self.url:
            return HttpResult(0, {}, b"", "server url is empty")
        h = self._headers()
        for k, v in (headers or {}).items():
            h[k] = v
        url = self.url + path
        res = http_call(url, method, data, h, timeout=timeout, verify=self.verify)
        if res.status in (401, 403) and _retry:
            if self.login(force=True):
                return self.raw(method, path, data, headers, timeout, _retry=False)
        return res

    def api(self, method, path, data=None, headers=None, timeout=30):
        """Call a qBittorrent WebAPI v2 path (already starting with /api/v2)."""
        if not self._sid and not self._auth_disabled:
            self.login()
        return self.raw(method, path, data, headers, timeout)

    def version(self):
        res = self.api("GET", "/api/v2/app/version")
        if res.status == 200:
            return res.text.strip().strip('"')
        return ""

    def test(self):
        if not self.login(force=True):
            return {"ok": False, "error": "login failed", "kind": self.kind}
        res = self.api("GET", "/api/v2/app/version")
        if res.status == 200:
            return {"ok": True, "kind": self.kind, "version": res.text.strip().strip('"')}
        return {"ok": False, "error": res.error or ("http %s" % res.status), "kind": self.kind}


# --------------------------------------------------------------------------
# Transmission client - translated into qBittorrent shaped replies
# --------------------------------------------------------------------------
TR_STATUS = {
    0: "stopped",
    1: "queued",
    2: "checking",
    3: "queued",
    4: "downloading",
    5: "queued",
    6: "seeding",
}


class TRClient(object):
    kind = "transmission"

    def __init__(self, server):
        self.server = server or {}
        self.url = (self.server.get("url") or "").strip().rstrip("/")
        self.username = self.server.get("username") or ""
        self.password = self.server.get("password") or ""
        self.verify = bool(self.server.get("verify_ssl", False))
        self._sid = None
        self._lock = threading.RLock()
        if not self.url.endswith("/rpc"):
            self.url = self.url + "/transmission/rpc"

    def _headers(self):
        h = {"Content-Type": "application/json", "Accept": "application/json"}
        if self._sid:
            h["X-Transmission-Session-Id"] = self._sid
        if self.username:
            import base64

            token = base64.b64encode(
                ("%s:%s" % (self.username, self.password)).encode("utf-8")
            ).decode("ascii")
            h["Authorization"] = "Basic " + token
        return h

    def rpc(self, method, arguments=None, _retry=True):
        payload = json.dumps({"method": method, "arguments": arguments or {}}).encode("utf-8")
        res = http_call(self.url, "POST", payload, self._headers(), timeout=30, verify=self.verify)
        if res.status == 409 and _retry:
            sid = res.headers.get("X-Transmission-Session-Id")
            if sid:
                self._sid = sid
                return self.rpc(method, arguments, _retry=False)
        if res.status in (401, 403):
            return HttpResult(res.status, res.headers, res.body, "auth")
        try:
            return HttpResult(res.status, res.headers, res.body, None) if res.status else res
        except Exception:
            return res

    def json_rpc(self, method, arguments=None):
        res = self.rpc(method, arguments)
        if res.status != 200:
            return None, res
        try:
            return json.loads(res.text), None
        except Exception as exc:
            return None, HttpResult(res.status, res.headers, res.body, repr(exc))

    # -- qB flavoured surface ---------------------------------------------
    def torrents_info(self):
        data, err = self.json_rpc(
            "torrent-get",
            {
                "fields": [
                    "id", "hashString", "name", "totalSize", "sizeWhenDone",
                    "percentDone", "rateDownload", "rateUpload", "uploadedEver",
                    "downloadedEver", "eta", "status", "addedDate", "doneDate",
                    "downloadDir", "error", "errorString", "isFinished",
                    "peersConnected", "peersSendingToUs", "peersGettingFromUs",
                    "seedRatioLimit", "seedRatioMode", "uploadRatio", "labels",
                    "queuePosition", "sequentialDownload",
                ]
            },
        )
        if not data:
            return None
        out = []
        for t in data.get("arguments", {}).get("torrents", []):
            st = TR_STATUS.get(t.get("status"), "unknown")
            total = float(t.get("totalSize") or 0)
            done = float(t.get("sizeWhenDone") or 0)
            pct = float(t.get("percentDone") or 0) * 100.0
            if t.get("isFinished"):
                st = "seeding" if t.get("rateUpload") else "stalledUP" if st == "seeding" else st
            eta = t.get("eta")
            if eta in (-1, -2) or eta is None:
                eta = 8640000
            out.append(
                {
                    "hash": t.get("hashString"),
                    "name": t.get("name"),
                    "size": total,
                    "total_size": total,
                    "completed": int(total * pct / 100.0),
                    "progress": round(pct / 100.0, 6),
                    "dlspeed": t.get("rateDownload") or 0,
                    "upspeed": t.get("rateUpload") or 0,
                    "downloaded": t.get("downloadedEver") or 0,
                    "uploaded": t.get("uploadedEver") or 0,
                    "ratio": t.get("uploadRatio") if t.get("uploadRatio") not in (-1, -2) else 0,
                    "eta": eta,
                    "state": st,
                    "category": (t.get("labels") or [""])[0] if t.get("labels") else "",
                    "tags": ",".join(t.get("labels") or []),
                    "save_path": t.get("downloadDir") or "",
                    "added_on": t.get("addedDate") or 0,
                    "completion_on": t.get("doneDate") or 0,
                    "num_seeds": t.get("peersSendingToUs") or 0,
                    "num_leechs": t.get("peersGettingFromUs") or 0,
                    "num_complete": 0,
                    "num_incomplete": 0,
                    "num_leechs_connected": t.get("peersConnected") or 0,
                    "priority": t.get("queuePosition") or 0,
                    "seq_dl": bool(t.get("sequentialDownload")),
                    "error": 1 if t.get("error") else 0,
                    "error_str": t.get("errorString") or "",
                    "client": "transmission",
                    "_tr_id": t.get("id"),
                }
            )
        return out

    def test(self):
        data, err = self.json_rpc("session-get")
        if data:
            return {"ok": True, "kind": self.kind, "version": data.get("arguments", {}).get("version", "")}
        res = err or HttpResult()
        return {"ok": False, "kind": self.kind, "error": res.error or "unreachable"}


def make_client(server):
    if (server or {}).get("kind") == "transmission":
        return TRClient(server)
    return QBClient(server)


# --------------------------------------------------------------------------
# backups
#
# Two folders are involved, mirroring what 敲门knock does:
#   * the app share  - /vol1/@appshare/<appname> (declared via config/resource
#     data-share) which the user can see in the fnOS file manager / over SMB;
#     automatic backups are written to <share>/backups so they are reachable
#     without SSH.
#   * the package var dir - used as a fallback when the share is unavailable.
#
# A backup is a plain JSON document so it stays inspectable and portable.
# --------------------------------------------------------------------------
BACKUP_PREFIX = "qbpanel-backup-"
BACKUP_EXT = ".json"
BACKUP_FORMAT = 1

RETENTION_MIN_DAYS = 1
RETENTION_MAX_DAYS = 3650
INTERVAL_MIN_HOURS = 1
INTERVAL_MAX_HOURS = 8760


def share_dir():
    """The app's shared folder (visible in fnOS), or '' when unavailable.

    Resolved on every call rather than cached at startup, and probed through
    several layouts because the paths available to the process depend on how
    fnOS happened to launch it:
      * during installation cmd/main runs from the staging directory
        (/vol1/appcenter-downloads/<app>-tpk), whose shares/ does not exist;
      * the installed app tree is /var/apps/<appname> (shares/ symlinks live
        there);
      * the physical share area is /vol<n>/@appshare/<appname>.
    """
    cands = [os.environ.get("QBPANEL_SHARE_DIR")]
    for pat in ("/vol*/@appshare/" + APP_NAME,):
        cands.extend(sorted(glob.glob(pat)))
    app_root_env = os.environ.get("QBPANEL_APP_ROOT") or ""
    if app_root_env:
        cands.append(os.path.join(app_root_env, "shares", APP_NAME))
    cands.append(os.path.join(os.path.dirname(app_root()), "shares", APP_NAME))
    cands.append(os.path.join("/var/apps", APP_NAME, "shares", APP_NAME))
    for cand in cands:
        if cand and os.path.isdir(cand):
            return cand
    return ""


def backup_dir():
    d = share_dir()
    if d:
        sub = os.path.join(d, "backups")
        try:
            os.makedirs(sub, exist_ok=True)
            return sub
        except OSError:
            pass
    d = os.path.join(var_dir(), "backups")
    try:
        os.makedirs(d, exist_ok=True)
    except OSError:
        pass
    return d


def make_backup(store, kind="manual"):
    with store._lock:
        settings = json.loads(json.dumps(store.data.get("settings") or {}))
        servers = [dict(s) for s in (store.data.get("servers") or [])]
        current = store.data.get("current") or ""
    return {
        "app": APP_NAME,
        "format": BACKUP_FORMAT,
        "version": VERSION,
        "kind": kind,
        "created_at": int(time.time()),
        "payload": {
            "settings": settings,
            "servers": servers,
            "current": current,
        },
    }


def backup_filename(stamp=None):
    ts = stamp if stamp is not None else time.time()
    return "%s%s%s" % (BACKUP_PREFIX, time.strftime("%Y%m%d-%H%M%S", time.localtime(ts)), BACKUP_EXT)


def write_backup(data, folder=None):
    folder = folder or backup_dir()
    os.makedirs(folder, exist_ok=True)
    path = os.path.join(folder, backup_filename(data.get("created_at")))
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
    return path


def list_backups(folder=None):
    folder = folder or backup_dir()
    out = []
    try:
        names = os.listdir(folder)
    except OSError:
        return out
    for n in names:
        if not n.startswith(BACKUP_PREFIX) or not n.endswith(BACKUP_EXT):
            continue
        p = os.path.join(folder, n)
        try:
            st = os.stat(p)
        except OSError:
            continue
        out.append({"name": n, "size": st.st_size, "mtime": int(st.st_mtime), "path": p})
    out.sort(key=lambda b: b["name"], reverse=True)
    return out


def prune_backups(retention_days, folder=None):
    """Delete auto backups older than retention_days. Manual exports kept."""
    folder = folder or backup_dir()
    days = max(RETENTION_MIN_DAYS, min(RETENTION_MAX_DAYS, int(retention_days or 0) or 30))
    cutoff = time.time() - days * 86400.0
    removed = 0
    for b in list_backups(folder):
        if b["mtime"] >= cutoff:
            continue
        try:
            os.remove(b["path"])
            removed += 1
        except OSError:
            pass
    return removed


def parse_backup(raw):
    """Validate raw bytes as a qBpanel backup document."""
    try:
        data = json.loads(raw.decode("utf-8"))
    except Exception:
        raise ValueError("unreadable")
    if not isinstance(data, dict) or data.get("app") not in (APP_NAME,) + LEGACY_APP_NAMES:
        raise ValueError("foreign")
    payload = data.get("payload")
    if not isinstance(payload, dict):
        raise ValueError("empty")
    if not isinstance(payload.get("servers"), list):
        raise ValueError("empty")
    return data


def apply_backup(store, data):
    payload = data.get("payload") or {}
    with store._lock:
        servers = payload.get("servers") or []
        store.data["servers"] = [dict(s) for s in servers if isinstance(s, dict)]
        ids = [s.get("id") for s in store.data["servers"]]
        cur = payload.get("current") or ""
        store.data["current"] = cur if cur in ids else (ids[0] if ids else "")
        settings = payload.get("settings")
        if isinstance(settings, dict):
            store.data.setdefault("settings", {}).update(settings)
        store.save()
    return {"servers": len(store.data["servers"])}
