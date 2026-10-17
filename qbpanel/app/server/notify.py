"""qbpanel : notification channels.

Every channel is a small adapter that turns (title, body) into one HTTP call.
Only the standard library is used, matching the rest of the app.

Secret handling: values listed in SECRET_FIELDS are never sent back to the
browser. The public view replaces a stored secret with the literal
SECRET_MARK, and a save that submits SECRET_MARK (or an empty value) keeps
whatever is already on disk.
"""
import json
import ssl
import urllib.error
import urllib.parse
import urllib.request

SECRET_MARK = "__SET__"

# type -> (label_zh, label_en, secret field names, field order)
CHANNEL_TYPES = {
    "bark": {
        "label_zh": "Bark",
        "label_en": "Bark",
        "secrets": ("key",),
        "fields": ("server", "key"),
    },
    "serverchan": {
        "label_zh": "Server 酱",
        "label_en": "ServerChan",
        "secrets": ("sendkey",),
        "fields": ("sendkey",),
    },
    "pushplus": {
        "label_zh": "PushPlus",
        "label_en": "PushPlus",
        "secrets": ("token",),
        "fields": ("token",),
    },
    "wxpusher": {
        "label_zh": "WxPusher",
        "label_en": "WxPusher",
        "secrets": ("app_token",),
        "fields": ("app_token", "uids", "topics"),
    },
    "webhook": {
        "label_zh": "自定义 Webhook",
        "label_en": "Custom webhook",
        "secrets": ("headers",),
        "fields": ("url", "headers"),
    },
}


def type_list(lang="zh"):
    out = []
    for key, meta in CHANNEL_TYPES.items():
        out.append({
            "type": key,
            "label": meta["label_zh"] if lang == "zh" else meta["label_en"],
        })
    return out


def channel_public(ch):
    """Channel shape for the browser - stored secrets are replaced by a mark."""
    meta = CHANNEL_TYPES.get(ch.get("type") or "", {"secrets": (), "fields": ()})
    cfg = ch.get("config") or {}
    out = {}
    for key in meta["fields"]:
        val = cfg.get(key)
        if key in meta["secrets"]:
            out[key] = SECRET_MARK if val else ""
        else:
            out[key] = val if val is not None else ""
    return {
        "id": ch.get("id") or "",
        "name": ch.get("name") or "",
        "type": ch.get("type") or "",
        "enabled": bool(ch.get("enabled", True)),
        "config": out,
        "fields": list(meta["fields"]),
        "secrets": list(meta["secrets"]),
    }


def merge_config(ch_type, incoming, existing):
    """Keep stored secrets when the form echoes the mark or leaves the field blank."""
    meta = CHANNEL_TYPES.get(ch_type or "", {"secrets": (), "fields": ()})
    old = existing or {}
    out = {}
    for key in meta["fields"]:
        val = (incoming or {}).get(key, None)
        if key in meta["secrets"]:
            if val in (None, "", SECRET_MARK, "__KEEP__"):
                out[key] = old.get(key) or ""
            else:
                out[key] = str(val).strip()
        else:
            out[key] = "" if val is None else str(val).strip()
    return out


# --------------------------------------------------------------------------
# transport
# --------------------------------------------------------------------------
def _open(req, timeout, verify=True):
    ctx = None if verify else ssl._create_unverified_context()
    with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
        return resp.status, resp.read(4096).decode("utf-8", "replace")


def _post_json(url, payload, headers=None, timeout=8):
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    h = {
        "Content-Type": "application/json; charset=utf-8",
        "User-Agent": "qBpanel",
    }
    h.update(headers or {})
    req = urllib.request.Request(url, data=data, headers=h, method="POST")
    return _open(req, timeout)


def _post_form(url, fields, timeout=8):
    data = urllib.parse.urlencode(fields).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers={
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "qBpanel",
    }, method="POST")
    return _open(req, timeout)


def _parse_headers(raw):
    out = {}
    for line in (raw or "").splitlines():
        line = line.strip()
        if not line or ":" not in line:
            continue
        k, v = line.split(":", 1)
        if k.strip():
            out[k.strip()] = v.strip()
    return out


def _fail(msg):
    return {"ok": False, "detail": str(msg)[:300]}


def send(channel, title, body):
    """Deliver one message. Returns {'ok': bool, 'detail': str}."""
    ctype = (channel.get("type") or "").strip()
    cfg = channel.get("config") or {}
    try:
        if ctype == "bark":
            server = (cfg.get("server") or "https://api.day.app").strip().rstrip("/")
            key = (cfg.get("key") or "").strip()
            if not key:
                return _fail("缺少设备 key")
            url = "%s/%s" % (server, urllib.parse.quote(key))
            status, text = _post_json(url, {
                "title": title,
                "body": body,
                "group": "qBpanel",
                "icon": "",
            })
            return _result(status, text, expect_json_code=200)

        if ctype == "serverchan":
            key = (cfg.get("sendkey") or "").strip()
            if not key:
                return _fail("缺少 SendKey")
            # v3 keys look like SCT...; both forms post to sctapi.ftqq.com
            url = "https://sctapi.ftqq.com/%s.send" % key
            status, text = _post_form(url, {"title": title, "desp": body})
            return _result(status, text, expect_json_code=0)

        if ctype == "pushplus":
            token = (cfg.get("token") or "").strip()
            if not token:
                return _fail("缺少 token")
            status, text = _post_json("https://www.pushplus.plus/send", {
                "token": token,
                "title": title,
                "content": body,
                "template": "markdown",
            })
            return _result(status, text, expect_json_code=200)

        if ctype == "wxpusher":
            app_token = (cfg.get("app_token") or "").strip()
            if not app_token:
                return _fail("缺少 appToken")
            uids = [x.strip() for x in (cfg.get("uids") or "").split(",") if x.strip()]
            topics = []
            for x in (cfg.get("topics") or "").split(","):
                x = x.strip()
                if x.isdigit():
                    topics.append(int(x))
            payload = {
                "appToken": app_token,
                "content": body,
                "summary": title[:99],
                "contentType": 1,
            }
            if uids:
                payload["uids"] = uids
            if topics:
                payload["topicIds"] = topics
            status, text = _post_json("https://wxpusher.zjiecode.com/api/send/message", payload)
            return _result(status, text, expect_json_code=1000)

        if ctype == "webhook":
            url = (cfg.get("url") or "").strip()
            if not url.startswith("http"):
                return _fail("Webhook 地址无效")
            status, text = _post_json(url, {
                "title": title,
                "content": body,
                "source": "qBpanel",
            }, _parse_headers(cfg.get("headers") or ""))
            return _result(status, text)

        return _fail("未知渠道类型：%s" % ctype)
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            detail = exc.read(300).decode("utf-8", "replace")
        except Exception:
            pass
        return _fail("HTTP %d %s" % (exc.code, detail))
    except urllib.error.URLError as exc:
        return _fail(getattr(exc, "reason", exc))
    except Exception as exc:  # pragma: no cover - defensive
        return _fail(exc)


def _result(status, text, expect_json_code=None):
    if status < 200 or status >= 300:
        return _fail("HTTP %d %s" % (status, text[:200]))
    if expect_json_code is not None:
        try:
            data = json.loads(text)
        except Exception:
            return {"ok": True, "detail": text[:120]}
        code = data.get("code")
        if code is not None and int(code) != expect_json_code:
            msg = data.get("message") or data.get("msg") or text[:160]
            return _fail("服务返回 %s：%s" % (code, msg))
        return {"ok": True, "detail": ""}
    return {"ok": True, "detail": text[:120]}
