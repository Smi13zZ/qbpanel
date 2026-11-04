"""qbpanel : notification channels.

Every channel is a small adapter that turns (title, body) into one HTTP call.
Only the standard library is used, matching the rest of the app.

Secret handling: values listed in SECRET_FIELDS are never sent back to the
browser. The public view replaces a stored secret with the literal
SECRET_MARK, and a save that submits SECRET_MARK (or an empty value) keeps
whatever is already on disk.

渠道清单分两组：早期落地的是 Bark / Server 酱 / PushPlus / WxPusher /
自定义 Webhook，之后又补了 Telegram / 企业微信机器人 / 钉钉机器人 / Slack。
前五个的键名、字段名与 SECRET_MARK 语义保持不变，已存下来的老配置照常发送。

每个渠道除字段顺序外还带 labels / hints 两份双语元数据，供面板按当前
语言渲染表单；type_meta() 把它们按语言摊平后一次性交给前端。
"""
import base64
import hashlib
import hmac
import json
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request

SECRET_MARK = "__SET__"

# type -> 显示名 / 密钥字段 / 字段顺序 / 字段显示名与说明
#
# fields 决定表单里字段的排列顺序，secrets 里的字段永远不回传浏览器。
# labels 与 hints 按字段各存中英两份，供面板按当前语言渲染；hints 允许为空。
CHANNEL_TYPES = {
    "bark": {
        "label_zh": "Bark",
        "label_en": "Bark",
        "secrets": ("key",),
        "fields": ("server", "key"),
        "labels": {
            "server": {"zh": "服务器地址", "en": "Server URL"},
            "key": {"zh": "设备 Key", "en": "Device key"},
        },
        "hints": {
            "server": {"zh": "留空则使用官方地址 https://api.day.app",
                       "en": "Leave empty to use https://api.day.app"},
            "key": {"zh": "Bark App 里显示的设备密钥",
                    "en": "The device key shown in the Bark app"},
        },
    },
    "serverchan": {
        "label_zh": "Server 酱",
        "label_en": "ServerChan",
        "secrets": ("sendkey",),
        "fields": ("sendkey",),
        "labels": {
            "sendkey": {"zh": "SendKey", "en": "SendKey"},
        },
        "hints": {
            "sendkey": {"zh": "Server 酱后台的 SendKey，通常以 SCT 开头",
                        "en": "The SendKey from your ServerChan account, usually starting with SCT"},
        },
    },
    "pushplus": {
        "label_zh": "PushPlus",
        "label_en": "PushPlus",
        "secrets": ("token",),
        "fields": ("token",),
        "labels": {
            "token": {"zh": "Token", "en": "Token"},
        },
        "hints": {
            "token": {"zh": "PushPlus 账号页给出的推送 token",
                      "en": "The push token shown on your PushPlus account page"},
        },
    },
    "wxpusher": {
        "label_zh": "WxPusher",
        "label_en": "WxPusher",
        "secrets": ("app_token",),
        "fields": ("app_token", "uids", "topics"),
        "labels": {
            "app_token": {"zh": "AppToken", "en": "AppToken"},
            "uids": {"zh": "UID 列表", "en": "UID list"},
            "topics": {"zh": "主题 ID 列表", "en": "Topic ID list"},
        },
        "hints": {
            "app_token": {"zh": "WxPusher 应用的 AppToken",
                          "en": "AppToken of your WxPusher application"},
            "uids": {"zh": "可留空；多个 UID 用英文逗号分隔",
                     "en": "Optional; separate multiple UIDs with commas"},
            "topics": {"zh": "可留空；多个主题 ID 用英文逗号分隔",
                       "en": "Optional; separate multiple topic IDs with commas"},
        },
    },
    "telegram": {
        "label_zh": "Telegram",
        "label_en": "Telegram",
        "secrets": ("bot_token",),
        "fields": ("bot_token", "chat_id", "api_base"),
        "labels": {
            "bot_token": {"zh": "Bot Token", "en": "Bot token"},
            "chat_id": {"zh": "Chat ID", "en": "Chat ID"},
            "api_base": {"zh": "API 地址", "en": "API base"},
        },
        "hints": {
            "bot_token": {"zh": "向 @BotFather 申请机器人时拿到的 token",
                          "en": "The token @BotFather gives you for the bot"},
            "chat_id": {"zh": "接收消息的会话 ID；私聊填用户 ID，群组填负数 ID",
                        "en": "Target chat ID; a user ID for private chats, a negative ID for groups"},
            "api_base": {"zh": "留空使用 https://api.telegram.org，走自建中转时填这里",
                         "en": "Empty means https://api.telegram.org; set it when using a relay"},
        },
    },
    "wecom": {
        "label_zh": "企业微信机器人",
        "label_en": "WeCom bot",
        "secrets": ("key",),
        "fields": ("key",),
        "labels": {
            "key": {"zh": "机器人 Key", "en": "Bot key"},
        },
        "hints": {
            "key": {"zh": "群机器人 Webhook 地址里 key= 后面那一段",
                    "en": "The part after key= in the group bot webhook URL"},
        },
    },
    "dingtalk": {
        "label_zh": "钉钉机器人",
        "label_en": "DingTalk bot",
        "secrets": ("url", "secret"),
        "fields": ("url", "secret"),
        "labels": {
            "url": {"zh": "Webhook 地址", "en": "Webhook URL"},
            "secret": {"zh": "加签密钥", "en": "Signing secret"},
        },
        "hints": {
            "url": {"zh": "群机器人的 Webhook 完整地址",
                    "en": "Full webhook URL of the group bot"},
            "secret": {"zh": "机器人开启「加签」时必填，未开启可留空",
                       "en": "Required when the bot has signing enabled, otherwise leave empty"},
        },
    },
    "slack": {
        "label_zh": "Slack",
        "label_en": "Slack",
        "secrets": ("url",),
        "fields": ("url",),
        "labels": {
            "url": {"zh": "Webhook 地址", "en": "Webhook URL"},
        },
        "hints": {
            "url": {"zh": "Slack App 的 Incoming Webhook 地址",
                    "en": "Incoming webhook URL of your Slack app"},
        },
    },
    "webhook": {
        "label_zh": "自定义 Webhook",
        "label_en": "Custom webhook",
        "secrets": ("headers",),
        "fields": ("url", "headers"),
        "labels": {
            "url": {"zh": "Webhook 地址", "en": "Webhook URL"},
            "headers": {"zh": "自定义请求头", "en": "Custom headers"},
        },
        "hints": {
            "url": {"zh": "接收 POST 请求的完整地址",
                    "en": "Full address that receives the POST request"},
            "headers": {"zh": "每行一个，格式为「名称: 值」",
                        "en": "One per line, formatted as name: value"},
        },
    },
}


def _pick(entry, lang):
    """双语取值：entry 是 {zh, en} 时按语言取，否则原样返回。"""
    if isinstance(entry, dict):
        key = "en" if str(lang or "zh").lower().startswith("en") else "zh"
        return entry.get(key) or entry.get("zh") or entry.get("en") or ""
    return entry if entry is not None else ""


def label_for(ctype, field, lang="zh"):
    """某个渠道某个字段在当前语言下的显示名，缺省回落到字段名本身。"""
    meta = CHANNEL_TYPES.get(ctype) or {}
    return _pick((meta.get("labels") or {}).get(field), lang) or str(field)


def hint_for(ctype, field, lang="zh"):
    """某个渠道某个字段在当前语言下的说明，没有说明时返回空串。"""
    meta = CHANNEL_TYPES.get(ctype) or {}
    return _pick((meta.get("hints") or {}).get(field), lang)


def type_meta(lang="zh"):
    """各渠道的表单元数据，按当前语言摊平后交给前端。

    面板据此动态渲染字段，新增渠道时只改这里，前端不用再内置一份字段表。
    labels / hints 是摊平后的当前语言字符串，labels_i18n / hints_i18n 保留
    中英两份，方便前端在切换语言时不重新拉接口。
    """
    out = {}
    for key, meta in CHANNEL_TYPES.items():
        fields = list(meta["fields"])
        out[key] = {
            "label_zh": meta["label_zh"],
            "label_en": meta["label_en"],
            "label": meta["label_zh"] if str(lang or "zh").lower().startswith("zh") else meta["label_en"],
            "fields": fields,
            "secrets": list(meta["secrets"]),
            "labels": {f: label_for(key, f, lang) for f in fields},
            "hints": {f: hint_for(key, f, lang) for f in fields},
            "labels_i18n": {f: dict((meta.get("labels") or {}).get(f) or {}) for f in fields},
            "hints_i18n": {f: dict((meta.get("hints") or {}).get(f) or {}) for f in fields},
        }
    return out


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
    # 标题可能缺失（比如只发正文的调用方），统一成字符串免得拼出 "None"
    title = str(title or "")
    body = str(body or "")
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

        if ctype == "telegram":
            token = (cfg.get("bot_token") or "").strip()
            chat_id = (cfg.get("chat_id") or "").strip()
            if not token:
                return _fail("缺少 Bot Token")
            if not chat_id:
                return _fail("缺少 Chat ID")
            base = (cfg.get("api_base") or "https://api.telegram.org").strip().rstrip("/")
            url = "%s/bot%s/sendMessage" % (base, token)
            status, text = _post_json(url, {
                "chat_id": chat_id,
                "text": ("%s\n%s" % (title or "", body or "")).strip(),
                "disable_web_page_preview": True,
            })
            if status < 200 or status >= 300:
                return _fail("HTTP %d %s" % (status, text[:200]))
            # HTTP 成功只说明请求送达，真正的结果是响应里的 ok 字段
            try:
                data = json.loads(text)
            except Exception:
                return {"ok": True, "detail": text[:120]}
            if not data.get("ok"):
                return _fail("Telegram 返回失败：%s" % (data.get("description") or text[:160]))
            return {"ok": True, "detail": ""}

        if ctype == "wecom":
            key = (cfg.get("key") or "").strip()
            if not key:
                return _fail("缺少机器人 key")
            url = "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=%s" % urllib.parse.quote(key)
            status, text = _post_json(url, {
                "msgtype": "text",
                "text": {"content": ("%s\n%s" % (title or "", body or "")).strip()},
            })
            return _result_errcode(status, text)

        if ctype == "dingtalk":
            url = (cfg.get("url") or "").strip()
            if not url.startswith("http"):
                return _fail("Webhook 地址无效")
            url = _dingtalk_url(url, cfg.get("secret") or "")
            status, text = _post_json(url, {
                "msgtype": "text",
                "text": {"content": ("%s\n%s" % (title or "", body or "")).strip()},
            })
            return _result_errcode(status, text)

        if ctype == "slack":
            url = (cfg.get("url") or "").strip()
            if not url.startswith("http"):
                return _fail("Webhook 地址无效")
            # Slack 的 mrkdwn 用 * 包裹即加粗；没有标题时只发正文
            text = ("*%s*\n%s" % (title, body or "")).strip() if title else (body or "")
            status, resp = _post_json(url, {"text": text})
            return _result(status, resp)

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


def _result_errcode(status, text):
    """企业微信与钉钉的成败写在 JSON 的 errcode 里，HTTP 200 也可能是失败。"""
    if status < 200 or status >= 300:
        return _fail("HTTP %d %s" % (status, text[:200]))
    try:
        data = json.loads(text)
    except Exception:
        # 拿不到 JSON 就没法判断，按响应体本身当作成功处理
        return {"ok": True, "detail": text[:120]}
    code = data.get("errcode")
    if code not in (None, 0, "0"):
        return _fail("服务返回 %s：%s" % (code, data.get("errmsg") or text[:160]))
    return {"ok": True, "detail": ""}


def _dingtalk_url(url, secret):
    """钉钉机器人开启「加签」后，URL 必须补上 timestamp 与 sign。

    签名算法固定：以毫秒时间戳拼上换行和密钥做 HMAC-SHA256，结果先 base64
    再 urlencode。少这一步钉钉会直接回 400。
    """
    secret = (secret or "").strip()
    if not secret:
        return url
    stamp = str(int(time.time() * 1000))
    string_to_sign = "%s\n%s" % (stamp, secret)
    digest = hmac.new(secret.encode("utf-8"), string_to_sign.encode("utf-8"),
                      digestmod=hashlib.sha256).digest()
    sign = urllib.parse.quote_plus(base64.b64encode(digest))
    joiner = "&" if "?" in url else "?"
    return "%s%stimestamp=%s&sign=%s" % (url, joiner, stamp, sign)
