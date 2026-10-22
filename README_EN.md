<div align="center">

<img src="qbpanel/app/web/images/icon.png" width="104" alt="qBpanel">

# qBpanel

**A native BitTorrent control panel for fnOS** · qBittorrent / Transmission remote management

Pure Python 3 stdlib backend · Vue 3 SPA front-end · zero third-party dependencies · desktop and mobile friendly

[Features](#features) · [Screenshots](#screenshots) · [Install](#install) · [Usage](#usage) · [FAQ](#faq) · [Changelog](CHANGELOG.md) · [中文说明](README.md)

</div>

---

## What it is

qBpanel turns the web UI of qBittorrent and Transmission into a **native fnOS application** (`.fpk`) that opens straight from the fnOS desktop.

It is not a "wrapped webpage" — it is a full controller:

- **The panel ships its own local service** (default port `8898`); the browser only talks to that.
- **Downloader address, username and password live on the device only** (`@appdata/fn-qbpanel/config.json`). The panel logs in and relays requests on your behalf — nothing credentials-related is ever rendered into the page or sent to an external server.
- **Zero dependencies.** The backend uses only the Python 3 standard library; the Vue 3 build is bundled locally, so everything works offline.
- **One package for both x86 and ARM** fnOS boxes (nothing in the app is architecture-specific).

Two backends are supported: **qBittorrent (WebAPI v2, 4.x and 5.x)** and **Transmission (RPC)**. Transmission replies are translated server-side into the same shape the front-end already expects, so the UI speaks exactly one dialect.

---

## Features

| Area | What you get |
|---|---|
| **Overview** | Download / upload speed, active tasks, free disk space, session traffic; live speed chart (download + upload); task-distribution donut; recent tasks |
| **Tasks** | Name search; status filter (all / downloading / seeding / paused / error); 8 sort fields; multi-select batch pause, resume, recheck, throttle, delete |
| **Add task** | Magnet links, HTTP links, local `.torrent` upload — with save path, category, tags and "add paused" option |
| **Task detail** | Four tabs: general info, files (per-file priority), trackers, peers |
| **Servers** | Manage several qBittorrent / Transmission instances; test before saving; switch from the top bar; duplicate addresses rejected |
| **Stats** | All-time upload / download, global ratio, speed trend, status distribution, category share, connection info |
| **Logs** | Downloader log with level colours (normal / info / warning / critical) and auto refresh; switching servers swaps the log list with it |
| **Settings** | Sectioned work bar (panel / downloader / maintenance / notifications / update); tri-state theme, EN / 中文, refresh interval, global speed limits, default save path |
| **Backups** | Export / import JSON config, scheduled auto-backup into the fnOS app folder; the list shows five rows and scrolls, with restore or delete per entry |
| **Notifications** | Five channel types — Bark, ServerChan, PushPlus, WxPusher and custom webhooks; events for finished torrents and new releases; per-channel test send, secrets stay on the device; **delivery records** show whether each push went out, why it failed and what was sent |
| **Updates** | Reads the latest published release from GitHub and compares it with the installed build; a banner appears on every page and the sidebar flags it. **One-click update** downloads the package, runs the system installer and rolls back automatically if the new build fails to start |
| **Mobile** | Drawer sidebar, bottom-sheet pickers, card layout — tuned inside the fnOS phone app's embedded browser |
| **Deep links** | `?view=`, `?theme=`, `?lang=` and `?hash=` parameters |

### Backend support

| Downloader | Protocol | Notes |
|---|---|---|
| qBittorrent | WebAPI v2 | 4.x and 5.x both work: the 5.x changes to the login status code, session cookie name, `stop`/`start` endpoints and status names are all handled |
| Transmission | RPC | Translated internally; the first label becomes the category and the queue position becomes the priority |

---

## Screenshots

Desktop (1440px):

| Overview · light | Overview · dark |
|---|---|
| ![Overview light](docs/images/overview-light.png) | ![Overview dark](docs/images/overview-dark.png) |

| Tasks | Task detail (general) |
|---|---|
| ![Tasks](docs/images/torrents.png) | ![Task detail](docs/images/torrent-detail.png) |

| Servers | Stats |
|---|---|
| ![Servers](docs/images/servers.png) | ![Stats](docs/images/stats.png) |

| Logs | Settings |
|---|---|
| ![Logs](docs/images/logs.png) | ![Settings](docs/images/settings.png) |

Mobile (390px):

| Overview | Sidebar | Tasks | Settings |
|---|---|---|---|
| ![Mobile overview](docs/images/mobile-overview.png) | ![Mobile sidebar](docs/images/mobile-sidebar.png) | ![Mobile tasks](docs/images/mobile-torrents.png) | ![Mobile settings](docs/images/mobile-settings.png) |

---

## Install

### Requirements

- An fnOS device (x86 or ARM) — Python 3 is already part of the system;
- A reachable qBittorrent or Transmission instance (on the same box or elsewhere on the LAN).

### Option 1: install from the app center (recommended)

1. Download the latest `fn-qbpanel-<version>-fnos-all.fpk` from the Releases page;
2. fnOS → **App Center** → **Manual install**, pick that fpk;
3. The wizard asks for the panel port — default `8898`; change it if the port is taken;
4. A **qBpanel** icon appears on the fnOS desktop. You can also browse to `http://<device-ip>:8898`.

### Option 2: command line

```bash
printf 'wizard_backend_port=8898\n' > /tmp/qbpanel.env
sudo appcenter-cli install-fpk -e /tmp/qbpanel.env /path/to/fn-qbpanel-26.10.23-fnos-all.fpk
```

> Two gotchas: the `-e` env file is **mandatory**, otherwise you get
> `Something wrong with environment variables`; and `install-fpk` **will not
> upgrade** an already-installed app of the same name — run
> `appcenter-cli uninstall fn-qbpanel` first. Uninstalling keeps `@appdata`,
> so your config and backups survive.

### Where things live

| Item | Path |
|---|---|
| Program | `/usr/local/apps/@appcenter/fn-qbpanel` |
| Config & logs | `/usr/local/apps/@appdata/fn-qbpanel` |
| App folder (backups) | `/vol1/@appshare/fn-qbpanel/backups/` |

---

## Usage

### 1. Connect your downloader

The first run shows "no downloader configured". Click **Add server**:

| Field | Notes |
|---|---|
| Name | Anything; shown in the top-bar switcher |
| Type | `qBittorrent` or `Transmission` |
| URL | **As seen from the device**: `http://127.0.0.1:8080` if it runs on the same box, otherwise the LAN IP |
| Username / Password | Credentials of the downloader web UI (usually empty for Transmission RPC) |
| Verify HTTPS certificate | Turn off for self-signed HTTPS endpoints |

**Test connection** verifies address and credentials immediately and prints the downloader version; the panel **re-tests automatically after saving**, so the status chip shows "online / failed" right away. Leaving the password blank means "keep the current one".

> The rule of thumb: what matters is whether **the fnOS box running the panel** can reach that port — not whether your own PC can.

### 2. Overview

Four stat cards at the top (download speed, upload speed, active tasks, free disk space), a task-distribution donut on the left, a live speed chart with download and upload traces on the right, and the most recent tasks below.

The dot in the top-right corner is the connection state; the refresh button pulls a fresh snapshot. The refresh interval is configurable in Settings (default 2 s, front-end polling only).

### 3. Tasks

- **Search** filters by name;
- **Filter**: all / downloading / seeding / paused / error;
- **Sort**: name, size, progress, download speed, upload speed, ratio, ETA, added date — ascending or descending;
- **Batch actions** appear once tasks are selected: pause, resume, recheck, throttle, delete. Delete asks for confirmation and can remove the downloaded data as well;
- **Per-task throttling** sets per-task up/down caps in kB/s or MB/s; `0` means unlimited;
- **Add task** accepts magnet / HTTP links (one per line) or a local `.torrent` file, optional path, category and tags.

Clicking a task name slides in the **detail drawer** from the right:

- **General** — total size, downloaded / uploaded, ratio, average speeds, ETA, seeds / leechers, connections, pieces, save path, hash, added / completion time, created by, publish date, private flag, comment
- **Files** — per-file priority (skip / normal / high / maximum)
- **Trackers** — address, status and message, with a reannounce action
- **Peers** — remote address, port, client, origin, up/down speed

### 4. Servers

Every downloader instance as a card with name, type, address, status and version. Use **Set current** (all pages act on the current server) or switch straight from the top bar. Adding the same address twice is refused, so the list never fills up with duplicates.

### 5. Stats / Logs / Settings

Stats collects all-time traffic, global ratio, speed trend, status distribution, category share and connection info (listening port, DHT nodes, connection status, downloader version). Logs shows the downloader log with level colours and optional auto refresh; switching servers in the top bar swaps the list with it and discards replies that arrive from the previous downloader.

Settings opens with a sectioned work bar so one group of options is on screen at a time: **Panel** (theme, refresh interval, delete confirmation), **Downloader** (global limits, default save path, read-only connection info), **Maintenance** (backup & restore plus automatic backup), **Notifications**, and **Update**.

### 6. Notifications

Configured under Settings → Notifications. Channels: **Bark** (server + device key), **ServerChan** (SendKey), **PushPlus** (token), **WxPusher** (appToken, optional UID / topic), and a **custom webhook** (URL plus optional `Key: Value` headers). Two event switches: *torrent finished* (sent once per torrent) and *new version* (once per release). Each channel has a **Test** button; secrets are stored locally and never echoed back.

#### Delivery records

Below the channel list sits **Delivery records**. Every push leaves one entry — finished torrents, new releases and manual **Test** sends alike. Each row shows:

- **Sent / Failed**, with the failure reason when it failed (HTTP status, timeout, connection refused…);
- the **title and body** that were delivered (body capped at 600 characters), so you can confirm what actually went out;
- the **channel**, the event type (finished / new release / test) and the timestamp.

Filter by all / sent / failed, refresh by hand or clear the list. Records live in `/usr/local/apps/@appdata/fn-qbpanel/notify-log.json`, the latest 200 are kept, and they only hold message content — never channel secrets.

### 7. Updates

The panel queries the project's release feed once shortly after start-up. When a newer build exists, a dot appears next to *Settings* in the sidebar and a banner shows on every page (dismissable for the session). The Update section compares installed and latest version side by side and shows the release notes. **Update now** downloads the `.fpk`, runs the system installer and waits for the new build to answer; if it fails to start, the previous package is reinstalled automatically. If GitHub rate-limits the API (403), the panel falls back to the releases Atom feed and the asset list, so version, notes and package are still available.

---

## Backup & restore

The whole panel configuration — server list, credentials, all settings — can be backed up:

| Action | Notes |
|---|---|
| **Export backup** | Produces a `.json` archive and downloads it; on the phone it is handed to the system downloader |
| **Export to app folder** | Writes straight into `/vol1/@appshare/fn-qbpanel/backups/`, reachable from the file manager |
| **Import backup** | Choose a backup file to overwrite the current config (the page reloads afterwards) |
| **Auto backup** | Interval 1–8760 hours, retention 1–3650 days; the first copy is written immediately |
| **Earlier backups** | Five rows are shown, the rest scrolls inside the card with a sticky header; restore or delete per entry. On a phone the shared filename prefix is dropped so the timestamp fits |

> Forgot the downloader password? It is in the backup file in clear text — copy it out of the app folder and open it.

---

## Mobile

Inside the fnOS phone app the panel switches to its mobile layout automatically: the sidebar collapses into a top-left menu, drop-downs become bottom sheets, tasks become cards and dialogs anchor to the top. Long-press selection and the tap flash are disabled for a more native feel. Browsers below 640px get the same layout.

---

## Deep links

| Parameter | Values | Effect |
|---|---|---|
| `view` | `dash` / `torrents` / `servers` / `stats` / `logs` / `settings` | Open that page |
| `theme` | `dark` / `light` / `system` | Force theme (not saved) |
| `lang` | `zh` / `en` | Force interface language |
| `hash` | torrent hash | Open tasks page and expand that torrent |

```
http://<device-ip>:8898/?view=torrents&theme=dark&lang=en
```

---

## Build from source

Layout:

```
qbpanel/
├── manifest                 # package name, version, port, platform
├── ICON.PNG / ICON_256.PNG  # icons (64 / 256)
├── config/{privilege,resource}
├── wizard/{install,config}  # field names become environment variables
├── cmd/main                 # start / stop / status
└── app/
    ├── server/              # qbpanel.py (HTTP + API), backends.py (adapters)
    ├── web/                 # index.html, style.css, js/, lib/vue.global.prod.js
    └── ui/                  # desktop entry (index.cgi reverse proxy) + icons
```

```bash
python tools/build_fpk.py            # pack + push to the device
python tools/build_fpk.py --no-push  # pack only
```

> ⚠️ **Never repack the tar by hand on Windows**: it breaks the archive format
> and installation fails with `code 10111`. Sync the sources to Linux, run
> `chmod 755 cmd/* app/ui/index.cgi` (everything else `644`) and let the
> official `fnpack build` do the work — `tools/build_fpk.py` wraps exactly that.

Local run (no packing needed):

```bash
cd qbpanel/app/server
TRIM_PKGVAR=../../_local/var \
QBPANEL_SHARE_DIR=../../_local/share \
QBPANEL_PORT=8898 python3 qbpanel.py
# then open http://127.0.0.1:8898
```

---

## FAQ

**The panel will not open / the port is busy**
Pick another port in the app settings — the service restarts automatically; you can also set it during installation.

**It says the connection failed, yet I can open qBittorrent from my PC**
The address must be valid from the device's point of view. Same box → `http://127.0.0.1:8080`; another box → its LAN IP.

**How do I change the panel port?**
App Center → qBpanel → Settings, edit the port in the wizard and save; the service restarts on its own.

**Where are my data and backups?**
Config: `/usr/local/apps/@appdata/fn-qbpanel/config.json`; backups: `/vol1/@appshare/fn-qbpanel/backups/`.

**Why do Transmission categories and priorities differ?**
Transmission's protocol has no category field, so the first label is used as the category and the queue position as the priority — an approximation.

---

## Security

- Downloader credentials are stored only in the on-device config file; they never appear in the page and are never sent outside.
- ⚠️ **The panel itself has no authentication** — it is designed for LAN use. Do not expose port `8898` to the public internet. If you need remote access, put it behind a reverse proxy with authentication, or use a VPN / the fnOS remote-access feature.
- Exported backups contain credentials in clear text — store them safely.

---

## Known limitations

- Each downloader instance keeps a single session at a time. Running the web UI and the panel side by side is fine, but changing the password on the downloader side must be mirrored in the panel.
- Transmission categories / tags / priorities are approximations (see above).
- The panel does not proxy download traffic — only control requests.

---

## License

[MIT](LICENSE) © 2026 Smi13zZ

Not affiliated with qBittorrent, Transmission or fnOS.
