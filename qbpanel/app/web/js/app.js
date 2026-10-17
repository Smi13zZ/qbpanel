/* qbpanel - application logic (Vue 3, in-DOM template) */
(function () {
  "use strict";

  const FMT = window.QBP_FMT;
  const CHART = window.QBP_CHART;
  const I18N = window.QBP_I18N;

  /* ---------- inline svg icons (lucide-style, 1.8px stroke) ---------- */
  const S = 'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"';
  const svg = (body, size) =>
    '<svg width="' + (size || 18) + '" height="' + (size || 18) + '" viewBox="0 0 24 24" ' + S + '>' + body + '</svg>';

  const ICONS = {
    dash: svg('<rect x="3" y="3" width="7.5" height="9" rx="1.6"/><rect x="13.5" y="3" width="7.5" height="5.5" rx="1.6"/><rect x="13.5" y="12" width="7.5" height="9" rx="1.6"/><rect x="3" y="15.5" width="7.5" height="5.5" rx="1.6"/>'),
    torrents: svg('<path d="M4 6h16M4 12h16M4 18h10"/>'),
    servers: svg('<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7.5 7.5h.01M7.5 16.5h.01"/>'),
    stats: svg('<path d="M4 19V5"/><path d="M4 19h16"/><path d="M8 16l3-4 3 2 4-6"/>'),
    logs: svg('<path d="M5 3h10l4 4v14H5z"/><path d="M15 3v4h4"/><path d="M8 12h8M8 16h5"/>'),
    settings: svg('<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>'),
    menu: svg('<path d="M4 7h16M4 12h16M4 17h16"/>'),
    sun: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
    moon: svg('<path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5z"/>'),
    monitor: svg('<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>'),
    lang: svg('<path d="m5 8 6 6"/><path d="m4 14 6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/><path d="m22 22-5-10-5 10"/><path d="M14 18h6"/>'),
    globe: svg('<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18z"/>', 14),
    collapse: svg('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/><path d="m16 15-3-3 3-3"/>'),
    expand: svg('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/><path d="m14 9 3 3-3 3"/>'),
    refresh: svg('<path d="M20 11A8 8 0 0 0 6.3 6.3L4 8.5"/><path d="M4 4v4.5h4.5"/><path d="M4 13a8 8 0 0 0 13.7 4.7L20 15.5"/><path d="M20 20v-4.5h-4.5"/>'),
    plus: svg('<path d="M12 5v14M5 12h14"/>', 16),
    down: svg('<path d="M12 4v14"/><path d="M6 13l6 6 6-6"/>', 16),
    up: svg('<path d="M12 20V6"/><path d="M6 11l6-6 6 6"/>', 16),
    list: svg('<path d="M8 6h12M8 12h12M8 18h12"/><path d="M4 6h.01M4 12h.01M4 18h.01"/>'),
    hdd: svg('<rect x="3" y="5" width="18" height="6" rx="1.6"/><rect x="3" y="13" width="18" height="6" rx="1.6"/><path d="M7 8h.01M7 16h.01"/>', 16),
    play: svg('<path d="M7 5l12 7-12 7z"/>', 15),
    pause: svg('<path d="M9 5v14M15 5v14"/>', 15),
    trash: svg('<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/>', 15),
    close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
    sortAsc: svg('<path d="M12 19V5"/><path d="M6 11l6-6 6 6"/>', 16),
    sortDesc: svg('<path d="M12 5v14"/><path d="M6 13l6 6 6-6"/>', 16),
    download: svg('<path d="M12 3v12"/><path d="m7 11 5 5 5-5"/><path d="M4 20h16"/>', 16),
    folder: svg('<path d="M3 7a2 2 0 0 1 2-2h3.6l2 2.5H19a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>', 16),
  };

  const TRACKER_STATUS = { 0: "—", 1: "…", 2: "OK", 3: "…", 4: "!" };
  const THEME_ORDER = ["dark", "light", "system"];

  /* The global speed-limit boxes are edited in kB/s or MB/s - only these two
     units, 1024-based like qBittorrent's own WebUI. qB itself stores bytes/s,
     so every read/write goes through bytesToUnit() / unitToBytes(). */
  const LIMIT_UNITS = { kB: 1024, MB: 1024 * 1024 };

  /* how many backup rows stay visible before the list scrolls; mirrors the
     5-row viewport pinned by .bscroll in style.css */
  const BACKUP_ROWS = 5;

  function fmtNum(n) {
    n = Number(n) || 0;
    return n.toLocaleString();
  }

  Vue.createApp({
    data: function () {
      return {
        fmt: Object.assign({}, FMT, { fmtNum: fmtNum }),

        loaded: false,
        busy: false,
        navOpen: false,
        view: "dash",
        collapsed: false,
        lang: "zh",
        theme: "dark",
        themeOverride: "",

        qbVersion: "",
        appVersion: "1.0.0",

        servers: [],
        currentId: "",
        serverState: {},
        connected: false,
        connError: "",

        torrents: [],
        stats: {},

        search: "",
        filter: "all",
        filters: ["all", "downloading", "seeding", "paused", "error"],
        sortKeys: ["added_on", "name", "size", "progress", "dlspeed", "upspeed", "ratio", "eta"],
        sortKey: "added_on",
        sortAsc: false,
        selection: [],

        detail: null,
        detailTab: "general",
        detailTabs: ["general", "files", "trackers", "peers"],
        props: null,
        propsLoading: false,
        files: [],
        filesLoading: false,
        trackers: [],
        trackersLoading: false,
        peers: [],
        peersLoading: false,

        addOpen: false,
        addTab: "link",
        addForm: { urls: "", savepath: "", category: "", tags: "", paused: false, file: null },

        serverForm: null,
        serverTestMsg: "",

        limitOpen: false,
        limitForm: { dl: 0, up: 0 },
        limitFormUnit: { dl: "kB", up: "kB" },

        /* what the user typed in the two global limit boxes, interpreted in
           limitUnit; converted to bytes/s only when applying */
        limitUnit: { dl: "kB", up: "kB" },
        limitValue: { dl: 0, up: 0 },

        confirmBox: null,
        toasts: [],

        settings: {
          theme: "dark",
          theme_mode: "dark",
          lang: "zh",
          collapsed: false,
          refresh_ms: 2000,
          confirm_delete: true,
          auto_backup_enabled: false,
          auto_backup_interval_hours: 24,
          auto_backup_retention_days: 30,
        },
        prefs: {},

        isMobile: false,
        autoStatus: {},
        autoForm: { enabled: false, interval: 24, retention: 30 },
        backupFile: null,
        backupsVisible: BACKUP_ROWS,

        /* settings is a sectioned work bar now - one card group at a time */
        settingsTab: "panel",
        updateInfo: null,
        updateError: "",
        updateChecking: false,

        logs: [],
        logLevel: "normal",
        logLevels: ["normal", "info", "warning", "critical"],
        logAuto: false,

        /* mobile-only action-sheet picker that replaces the OS-native select
           popover on phones (the popover renders off-brand here and rows are
           hard to tap). set in openPicker(), cleared in closePicker().
           Named `pickerState` (not `_picker`) because keys prefixed with _
           are internal-only and don't reach the template. */
        pickerState: null,
      };
    },

    computed: {
      navItems: function () {
        const t = this.t;
        return [
          { id: "dash", icon: "dash", key: "nav.overview", label: t("nav.overview") },
          { id: "torrents", icon: "torrents", key: "nav.torrents", label: t("nav.torrents") },
          { id: "servers", icon: "servers", key: "nav.servers", label: t("nav.servers") },
          { id: "stats", icon: "stats", key: "nav.stats", label: t("nav.stats") },
          { id: "logs", icon: "logs", key: "nav.logs", label: t("nav.logs") },
          { id: "settings", icon: "settings", key: "nav.settings", label: t("nav.settings") },
        ];
      },
      pageTitle: function () {
        const item = this.navItems.filter((n) => n.id === this.view)[0];
        return item ? item.label : "qbpanel";
      },
      /* Sections of the settings page. The downloader section only exists when
         at least one downloader is configured, so the bar never offers a
         section that would render an empty page. */
      settingsTabs: function () {
        const t = this.t;
        const out = [
          { id: "panel", label: t("settings.tab.panel") },
          { id: "backup", label: t("settings.tab.backup") },
          { id: "auto", label: t("settings.tab.auto") },
          { id: "update", label: t("settings.tab.update") },
        ];
        if (this.servers.length) out.splice(1, 0, { id: "downloader", label: t("settings.tab.downloader") });
        return out;
      },
      updateNew: function () {
        return !!(this.updateInfo && this.updateInfo.has_update);
      },
      updateNotes: function () {
        return (this.updateInfo && this.updateInfo.notes) || "";
      },
      themeMode: function () {
        return this.themeOverride || this.settings.theme_mode || "dark";
      },
      themeIcon: function () {
        const m = this.themeMode;
        return m === "dark" ? "moon" : m === "light" ? "sun" : "monitor";
      },
      themeTooltip: function () {
        const m = this.themeMode;
        const next = THEME_ORDER[(THEME_ORDER.indexOf(m) + 1) % THEME_ORDER.length];
        return this.t("side.theme." + next);
      },
      torrentCount: function () {
        return this.torrents.length;
      },
      counts: function () {
        let active = 0, seeding = 0, paused = 0;
        this.torrents.forEach(function (t) {
          if (FMT.isActive(t)) active++;
          else if (FMT.isSeeding(t)) seeding++;
          if (FMT.isPaused(t)) paused++;
        });
        return { active: active, seeding: seeding, paused: paused };
      },
      filteredTorrents: function () {
        const self = this;
        const q = this.search.trim().toLowerCase();
        let list = this.torrents.filter(function (t) {
          if (q && (t.name || "").toLowerCase().indexOf(q) < 0 &&
              (t.category || "").toLowerCase().indexOf(q) < 0) return false;
          switch (self.filter) {
            case "downloading": return FMT.isActive(t);
            case "seeding": return FMT.isSeeding(t);
            case "paused": return FMT.isPaused(t);
            case "error": return FMT.isError(t);
            default: return true;
          }
        });
        const key = this.sortKey;
        const dir = this.sortAsc ? 1 : -1;
        list.sort(function (a, b) {
          let x = a[key], y = b[key];
          if (key === "name") return String(x || "").localeCompare(String(y || "")) * dir;
          return ((Number(x) || 0) - (Number(y) || 0)) * dir;
        });
        return list;
      },
      visibleTorrents: function () {
        return this.filteredTorrents;
      },
      allSelected: function () {
        return this.visibleTorrents.length > 0 && this.selection.length === this.visibleTorrents.length;
      },
      selectedTorrents: function () {
        const set = {};
        this.selection.forEach(function (h) { set[h] = true; });
        return this.torrents.filter(function (t) { return set[t.hash]; });
      },
      statusSegments: function () {
        let dl = 0, sd = 0, pa = 0, er = 0, ot = 0;
        this.torrents.forEach(function (t) {
          if (FMT.isError(t)) er++;
          else if (FMT.isActive(t)) dl++;
          else if (FMT.isSeeding(t)) sd++;
          else if (FMT.isPaused(t)) pa++;
          else ot++;
        });
        const t = this.t;
        const out = [
          { label: t("torrents.filter.downloading"), value: dl, color: CHART.cssVar("--dl", "#2563eb") },
          { label: t("torrents.filter.seeding"), value: sd, color: CHART.cssVar("--ok", "#16a34a") },
          { label: t("torrents.filter.paused"), value: pa, color: CHART.cssVar("--idle", "#a3a3a3") },
          { label: t("torrents.filter.error"), value: er, color: CHART.cssVar("--danger", "#e7000b") },
        ];
        if (ot) out.push({ label: "—", value: ot, color: CHART.cssVar("--warn", "#f59e0b") });
        return out;
      },
      categorySegments: function () {
        const m = {};
        this.torrents.forEach(function (t) {
          const c = t.category || "";
          m[c] = (m[c] || 0) + (Number(t.size) || 0);
        });
        return Object.keys(m).map(function (k) { return { label: k, value: m[k] }; })
          .sort(function (a, b) { return b.value - a.value; }).slice(0, 8);
      },
      maxCategory: function () {
        return this.categorySegments.reduce(function (a, c) { return Math.max(a, c.value); }, 1);
      },
      recent: function () {
        return this.torrents.slice().sort(function (a, b) {
          return (b.added_on || 0) - (a.added_on || 0);
        }).slice(0, 5);
      },
    },

    watch: {
      logAuto: function (v) { if (v) this.loadLogs(); },
      filter: function () { this.selection = []; },
      settingsTab: function (v) { if (v === "update" && !this.updateInfo) this.checkUpdate(false); },
    },

    mounted: function () {
      this.init();
      this._sparkTimer = setInterval(this.sparkTick, 1000);
      this._onResize = this.drawCharts.bind(this);
      window.addEventListener("resize", this._onResize);
      this._mq = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
      if (this._mq) {
        this._onScheme = () => { if (this.themeMode === "system") this.applyTheme(); };
        if (this._mq.addEventListener) this._mq.addEventListener("change", this._onScheme);
        else if (this._mq.addListener) this._mq.addListener(this._onScheme);
      }
      this._mmq = window.matchMedia ? window.matchMedia("(max-width: 640px)") : null;
      if (this._mmq) {
        this._onViewport = () => { this.isMobile = !!this._mmq.matches; };
        this._onViewport();
        if (this._mmq.addEventListener) this._mmq.addEventListener("change", this._onViewport);
        else if (this._mmq.addListener) this._mmq.addListener(this._onViewport);
      }
    },

    beforeUnmount: function () {
      clearInterval(this._sparkTimer);
      window.removeEventListener("resize", this._onResize);
      if (this._mq && this._onScheme) {
        if (this._mq.removeEventListener) this._mq.removeEventListener("change", this._onScheme);
        else if (this._mq.removeListener) this._mq.removeListener(this._onScheme);
      }
      if (this._mmq && this._onViewport) {
        if (this._mmq.removeEventListener) this._mmq.removeEventListener("change", this._onViewport);
        else if (this._mmq.removeListener) this._mmq.removeListener(this._onViewport);
      }
    },

    methods: {
      ic: function (name) { return ICONS[name] || ""; },

      t: function (key, vars) {
        if (!this._tc || this._tlang !== this.lang) {
          this._tc = I18N.makeT(this.lang);
          this._tlang = this.lang;
        }
        return this._tc(key, vars);
      },

      stLabel: function (state) {
        const info = FMT.stateInfo(state);
        const key = "state." + state;
        let label = this.t(key);
        if (label === key) label = info.label || state;
        return { label: label, tone: info.tone, group: info.group };
      },

      /* Log timestamps render as two stacked spans on mobile (date / time),
         one fixed-width column on desktop. Splitting here keeps the same
         template for both viewports and avoids reassembling `YYYY-MM-DD HH:MM`
         on the css side. */
      logDate: function (ts) {
        const full = FMT.fmtDate(ts);
        const sp = full.indexOf(" ");
        return sp > 0 ? full.slice(0, sp) : full;
      },
      logTime: function (ts) {
        const full = FMT.fmtDate(ts);
        const sp = full.indexOf(" ");
        return sp > 0 ? full.slice(sp + 1) : "";
      },

      /* Current-label getters for the mobile picker triggers. The settings-
         page labels here are already translated via t(); numeric enums
         (refresh interval, sort key) keep their pre-baked strings. */
      themeLabel: function () { return this.t("settings.theme." + this.settings.theme_mode); },
      intervalLabel: function () {
        const k = { 1000: "1 s", 2000: "2 s", 3000: "3 s", 5000: "5 s", 10000: "10 s" };
        return k[this.settings.refresh_ms] || (this.settings.refresh_ms / 1000) + " s";
      },
      sortLabel: function () { return this.t("torrents.sort." + this.sortKey); },
      serverKindLabel: function () {
        return this.serverForm && this.serverForm.kind === "transmission" ? "Transmission" : "qBittorrent";
      },
      filePrioLabel: function (p) {
        const k = { 0: "skip", 1: "normal", 6: "high", 7: "max" };
        const key = "detail.prio." + (k[String(p)] || "normal");
        return this.t(key);
      },
serverName: function () {
  const s = this.servers.find((x) => x.id === this.currentId);
  return s ? s.name : "";
},

      /* qBittorrent hands back connection_status as a raw English token
         (connected / firewalled / ...) - translate it, and pass anything we
         don't have a key for straight through instead of showing a missing key. */
      connLabel: function (v) {
        if (!v) return "—";
        const key = "conn." + String(v).toLowerCase();
        const out = this.t(key);
        return out === key ? String(v) : out;
      },

      toast: function (text, kind) {
        const id = Date.now() + Math.random();
        this.toasts.push({ id: id, text: text, kind: kind || "" });
        const self = this;
        setTimeout(function () {
          self.toasts = self.toasts.filter(function (t) { return t.id !== id; });
        }, kind === "err" ? 6000 : 3000);
      },

      /* Mobile action-sheet picker. Call from a v-if="!isMobile" select's
         sister button. cfg = { title, options:[{value,label}], value, onPick }.
         Picking a value calls onPick(picked), passing the same shape (value or
         string) the underlying @change would have received. */
      openPicker: function (cfg) {
        this.pickerState = cfg;
      },
      closePicker: function (val) {
        const p = this.pickerState;
        this.pickerState = null;
        if (val !== undefined && p && typeof p.onPick === "function") p.onPick(val);
      },

      /* ---------------- bootstrap ---------------- */
      init: async function () {
        try {
          const params = new URLSearchParams(location.search);
          const wanted = params.get("view");
          if (wanted && this.navItems.some((n) => n.id === wanted)) this.view = wanted;
          this.deepHash = params.get("hash") || "";

          const cfg = await API.config();
          this.appVersion = cfg.app_version || "1.0.0";
          this.settings = Object.assign(this.settings, cfg.settings || {});
          if (!this.settings.theme_mode) this.settings.theme_mode = this.settings.theme || "dark";

          const wantedTheme = params.get("theme");
          if (wantedTheme === "light" || wantedTheme === "dark" || wantedTheme === "system") {
            this.themeOverride = wantedTheme;
          }
          const wantedLang = params.get("lang");
          /* ?lang= must be able to force either language - testing the "en"
             branch alone left ?lang=zh silently falling back to the saved
             setting, so the deep link could never switch back to Chinese. */
          if (wantedLang === "en" || wantedLang === "zh") this.lang = wantedLang;
          else this.lang = this.settings.lang === "en" ? "en" : "zh";
          this.settings.lang = this.lang;
          this._tc = I18N.makeT(this.lang);
          this._tlang = this.lang;
          document.documentElement.setAttribute("lang", this.lang === "zh" ? "zh-CN" : "en");
          this.collapsed = !!this.settings.collapsed;

          this.servers = cfg.servers || [];
          this.currentId = cfg.current || (this.servers[0] && this.servers[0].id) || "";
          this.applyTheme();
          this.loaded = true;
          this.loadBackupStatus();
          if (this.view === "servers") this.testAllServers();
          if (this.currentId) await this.bootstrapServer();
          this.tick();
          setInterval(this.tick, 1000);
          /* deferred: the panel must paint before we spend a network round
             trip on the release feed (which may be slow or unreachable) */
          setTimeout(() => { this.checkUpdate(false); }, 1500);
        } catch (e) {
          this.loaded = true;
          this.toast(this.t("err.loadConfig", { v: e.message }), "err");
        }
      },

      bootstrapServer: async function () {
        try {
          const v = await API.qb("api/v2/app/version");
          this.qbVersion = typeof v === "string" ? v.replace(/^"|"$/g, "") : "";
        } catch (e) { /* ignore */ }
        this.loadPrefs();
        await this.refresh(true);
      },

      /* ---------------- theme / language / sidebar ---------------- */
      applyTheme: function () {
        const mode = this.themeMode;
        let eff = mode;
        if (mode === "system") {
          eff = (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) ? "dark" : "light";
        }
        this.theme = eff;
        document.documentElement.setAttribute("data-theme", eff);
        this.$nextTick(this.drawCharts);
      },

      cycleTheme: function () {
        const cur = this.themeMode;
        const next = THEME_ORDER[(THEME_ORDER.indexOf(cur) + 1) % THEME_ORDER.length];
        this.themeOverride = "";
        this.settings.theme_mode = next;
        this.applyTheme();
        this.saveSettings();
        this.toast(this.t(next === "dark" ? "msg.themeDark" : next === "light" ? "msg.themeLight" : "msg.themeSystem"));
      },

      setThemeMode: function (mode) {
        this.settings.theme_mode = mode;
        this.applyTheme();
        this.saveSettings();
      },

      toggleLang: function () {
        this.setLang(this.lang === "zh" ? "en" : "zh");
      },

      setLang: function (lang) {
        this.lang = lang === "en" ? "en" : "zh";
        this.settings.lang = this.lang;
        this._tc = I18N.makeT(this.lang);
        this._tlang = this.lang;
        document.documentElement.setAttribute("lang", this.lang === "zh" ? "zh-CN" : "en");
        this.saveSettings();
        this.toast(this.t("msg.langSwitched"));
      },

      toggleCollapse: function () {
        this.collapsed = !this.collapsed;
        this.settings.collapsed = this.collapsed;
        this.saveSettings();
        this.$nextTick(this.drawCharts);
      },

      /* ---------------- polling ---------------- */
      tick: function () {
        const now = Date.now();
        const iv = Number(this.settings.refresh_ms) || 2000;
        if (!this._lastPoll || now - this._lastPoll >= iv) {
          this._lastPoll = now;
          this.refresh();
        }
        if (this.logAuto && this.view === "logs" && (!this._lastLog || now - this._lastLog >= 5000)) {
          this._lastLog = now;
          this.loadLogs();
        }
      },

      refresh: async function (force) {
        if (!this.currentId || this.busy) return;
        if (force) this.busy = true;
        try {
          const d = await API.qb("api/v2/sync/maindata");
          this.connected = true;
          this.connError = "";
          if (d && d.server_state) this.stats = Object.assign({}, this.stats, d.server_state);
          if (d && d.torrents) {
            let list;
            if (d.full_update) {
              list = Object.keys(d.torrents).map(function (h) {
                return Object.assign({ hash: h }, d.torrents[h]);
              });
            } else {
              const map = {};
              this.torrents.forEach(function (t) { map[t.hash] = t; });
              Object.keys(d.torrents).forEach(function (h) {
                map[h] = Object.assign({}, map[h] || {}, d.torrents[h], { hash: h });
              });
              (d.removed || []).forEach(function (h) { delete map[h]; });
              list = Object.keys(map).map(function (h) { return map[h]; });
            }
            this.torrents = list;
            const alive = {};
            list.forEach(function (t) { alive[t.hash] = true; });
            this.selection = this.selection.filter(function (h) { return alive[h]; });
            this.maybeDeepLink();
          }
          if (this.detail) this.syncDetail();
        } catch (e) {
          this.connected = false;
          this.connError = e.message;
        } finally {
          if (force) this.busy = false;
        }
      },

      maybeDeepLink: function () {
        if (!this.deepHash || this._deepDone) return;
        const want = this.deepHash;
        const t = this.torrents.filter(function (x) { return x.hash === want; })[0];
        if (t) {
          this._deepDone = true;
          this.openDetail(t.hash);
        }
      },

      syncDetail: function () {
        const h = this.detail.hash;
        const fresh = this.torrents.filter(function (t) { return t.hash === h; })[0];
        if (!fresh) this.closeDetail();
        else this.detail = fresh;
      },

      go: function (id) {
        this.view = id;
        this.navOpen = false;
        if (id === "logs") this.loadLogs();
        if (id === "settings") this.loadBackupStatus();
        if (id === "servers") this.testAllServers();
        if (id === "stats" || id === "dash") this.$nextTick(this.drawCharts);
      },

      /* entering the servers page probes every server once, so the status
         chips are meaningful without having to click 测试连接 by hand */
      testAllServers: async function () {
        const list = this.servers.slice();
        for (let i = 0; i < list.length; i++) {
          const sid = list[i].id;
          this.serverState = Object.assign({}, this.serverState, { [sid]: "testing" });
          try {
            const r = await API.testServer(sid, {});
            this.serverState = Object.assign({}, this.serverState, { [sid]: !!(r && r.ok) });
          } catch (e) {
            this.serverState = Object.assign({}, this.serverState, { [sid]: false });
          }
        }
      },

      /* ---------------- torrent actions ---------------- */
      hashes: function (list) {
        return (list || []).map(function (t) { return t.hash; }).join("|");
      },

      torrentAction: async function (action, t) {
        const map = {
          pause: "api/v2/torrents/pause",
          resume: "api/v2/torrents/resume",
          recheck: "api/v2/torrents/recheck",
          reannounce: "api/v2/torrents/reannounce",
          increasePrio: "api/v2/torrents/increasePrio",
          decreasePrio: "api/v2/torrents/decreasePrio",
        };
        if (!map[action]) return;
        try {
          await API.qb(map[action], { method: "POST", form: true, body: { hashes: t.hash } });
          await this.refresh();
        } catch (e) {
          this.toast(this.t("err.opFailed", { v: e.message }), "err");
        }
      },

      togglePause: function (t) {
        this.torrentAction(FMT.isPaused(t) ? "resume" : "pause", t);
      },

      bulk: async function (action) {
        const hashes = this.hashes(this.selectedTorrents);
        if (!hashes) return;
        const path = action === "pause" ? "api/v2/torrents/pause"
          : action === "resume" ? "api/v2/torrents/resume"
          : "api/v2/torrents/recheck";
        try {
          await API.qb(path, { method: "POST", form: true, body: { hashes: hashes } });
          this.toast(this.t("msg.submitted", { n: this.selection.length }));
          await this.refresh();
        } catch (e) {
          this.toast(this.t("err.opFailed", { v: e.message }), "err");
        }
      },

      askDelete: function (list) {
        if (!list || !list.length) return;
        if (!this.settings.confirm_delete) {
          this.doDelete(list, false);
          return;
        }
        const self = this;
        this.confirmBox = {
          title: this.t("confirm.title"),
          text: list.length > 1
            ? this.t("confirm.many", { n: list.length })
            : this.t("confirm.one", { name: list[0].name }),
          askFiles: true,
          deleteFiles: false,
          okText: this.t("confirm.ok"),
          onOk: function (box) {
            self.confirmBox = null;
            self.doDelete(list, box.deleteFiles);
          },
        };
      },

      doDelete: async function (list, deleteFiles) {
        try {
          await API.qb("api/v2/torrents/delete", {
            method: "POST",
            form: true,
            body: { hashes: this.hashes(list), deleteFiles: deleteFiles ? "true" : "false" },
          });
          this.toast(this.t("msg.deleted", { n: list.length }));
          this.selection = [];
          if (this.detail && list.some((t) => t.hash === this.detail.hash)) this.closeDetail();
          await this.refresh();
        } catch (e) {
          this.toast(this.t("err.deleteFailed", { v: e.message }), "err");
        }
      },

      toggleAll: function (checked) {
        this.selection = checked ? this.visibleTorrents.map(function (t) { return t.hash; }) : [];
      },

      openLimit: function () {
        this.limitForm = { dl: 0, up: 0 };
        this.limitOpen = true;
      },

      applyLimit: async function () {
        const hashes = this.hashes(this.selectedTorrents);
        if (!hashes) return;
        try {
          await API.qb("api/v2/torrents/setDownloadLimit", {
            method: "POST", form: true,
            body: { hashes: hashes, limit: this.unitToBytes(this.limitForm.dl, this.limitFormUnit.dl) },
          });
          await API.qb("api/v2/torrents/setUploadLimit", {
            method: "POST", form: true,
            body: { hashes: hashes, limit: this.unitToBytes(this.limitForm.up, this.limitFormUnit.up) },
          });
          this.limitOpen = false;
          this.toast(this.t("msg.limitApplied"));
          await this.refresh();
        } catch (e) {
          this.toast(this.t("err.applyFailed", { v: e.message }), "err");
        }
      },

      /* ---------------- add ---------------- */
      openAdd: function () {
        this.addTab = "link";
        this.addForm = { urls: "", savepath: "", category: "", tags: "", paused: false, file: null };
        this.addOpen = true;
      },

      onPickFile: function (ev) {
        const f = ev.target.files && ev.target.files[0];
        this.addForm.file = f || null;
      },

      submitAdd: async function () {
        const f = this.addForm;
        if (this.addTab === "file" && !f.file) { this.toast(this.t("err.pickFile"), "err"); return; }
        if (this.addTab === "link" && !f.urls.trim()) { this.toast(this.t("err.enterUrl"), "err"); return; }
        this.busy = true;
        try {
          if (this.addTab === "file") {
            const res = await API.uploadTorrent(f.file, {
              filename: f.file.name, savepath: f.savepath, category: f.category,
              tags: f.tags, paused: f.paused ? "true" : "false",
            });
            if (!res || res.ok === false) throw new Error((res && res.body) || "failed");
          } else {
            await API.qb("api/v2/torrents/add", {
              method: "POST",
              form: true,
              body: {
                urls: f.urls.trim().split(/\s*\n\s*/).filter(Boolean).join("\n"),
                savepath: f.savepath, category: f.category, tags: f.tags,
                paused: f.paused ? "true" : "false",
              },
            });
          }
          this.addOpen = false;
          this.toast(this.t("msg.added"));
          await this.refresh();
        } catch (e) {
          this.toast(this.t("err.addFailed", { v: e.message }), "err");
        } finally {
          this.busy = false;
        }
      },

      /* ---------------- detail ---------------- */
      openDetail: function (hash) {
        const t = this.torrents.filter(function (x) { return x.hash === hash; })[0];
        if (!t) return;
        this.detail = t;
        this.detailTab = "general";
        this.props = null;
        this.files = [];
        this.trackers = [];
        this.peers = [];
        this.loadProps();
      },

      closeDetail: function () {
        this.detail = null;
        this.props = null;
      },

      onDetailTab: function (tab) {
        if (tab === "general") this.loadProps();
        if (tab === "files" && !this.files.length) this.loadFiles();
        if (tab === "trackers" && !this.trackers.length) this.loadTrackers();
        if (tab === "peers" && !this.peers.length) this.loadPeers();
      },

      loadProps: async function () {
        if (!this.detail) return;
        this.propsLoading = true;
        try {
          const arr = await API.qb("api/v2/torrents/properties", { params: { hash: this.detail.hash } });
          this.props = Array.isArray(arr) ? arr[0] : arr;
        } catch (e) { this.props = null; } finally { this.propsLoading = false; }
      },

      loadFiles: async function () {
        if (!this.detail) return;
        this.filesLoading = true;
        try {
          const arr = await API.qb("api/v2/torrents/files", { params: { hash: this.detail.hash } });
          this.files = Array.isArray(arr) ? arr : [];
        } catch (e) { this.files = []; } finally { this.filesLoading = false; }
      },

      loadTrackers: async function () {
        if (!this.detail) return;
        this.trackersLoading = true;
        try {
          const arr = await API.qb("api/v2/torrents/trackers", { params: { hash: this.detail.hash } });
          this.trackers = (Array.isArray(arr) ? arr : []).filter(function (t) {
            return t.url && t.url.indexOf("*") !== 0;
          });
        } catch (e) { this.trackers = []; } finally { this.trackersLoading = false; }
      },

      loadPeers: async function () {
        if (!this.detail) return;
        this.peersLoading = true;
        try {
          const d = await API.qb("api/v2/sync/torrentPeers", { params: { hash: this.detail.hash } });
          const raw = (d && d.peers) || {};
          const self = this;
          const out = [];
          Object.keys(raw).forEach(function (k) {
            const p = raw[k];
            const idx = k.lastIndexOf(":");
            out.push({
              ip: idx > 0 ? k.slice(0, idx) : k,
              port: idx > 0 ? k.slice(idx + 1) : "",
              client: p.client || "",
              origin: p.origin === 1 ? self.t("detail.inbound") : self.t("detail.outbound"),
              progress: p.progress,
              dl_speed: p.dl_speed,
              up_speed: p.up_speed,
            });
          });
          out.sort(function (a, b) { return (b.dl_speed + b.up_speed) - (a.dl_speed + a.up_speed); });
          this.peers = out;
        } catch (e) { this.peers = []; } finally { this.peersLoading = false; }
      },

      setFilePrio: async function (idx, priority) {
        try {
          await API.qb("api/v2/torrents/filePrio", {
            method: "POST", form: true,
            body: { hash: this.detail.hash, id: idx, priority: priority },
          });
          this.toast(this.t("msg.prioUpdated"));
          this.loadFiles();
        } catch (e) {
          this.toast(this.t("err.opFailed", { v: e.message }), "err");
        }
      },

      trackerStatus: function (code) { return TRACKER_STATUS[code] || "—"; },

      progressClass: function (t) {
        if (FMT.isError(t)) return "err";
        if (FMT.isDone(t)) return t.upspeed ? "done" : "paused";
        if (FMT.isPaused(t)) return "paused";
        return "";
      },

      setSort: function (key) {
        if (this.sortKey === key) this.sortAsc = !this.sortAsc;
        else { this.sortKey = key; this.sortAsc = key === "name"; }
      },

      /* ---------------- servers ---------------- */
      openServerForm: function (s) {
        this.serverTestMsg = "";
        this.serverForm = s ? Object.assign({}, s, { password: "" }) : {
          id: "", name: "", kind: "qbittorrent", url: "", username: "", password: "", verify_ssl: false,
        };
      },

      saveServer: async function () {
        const f = this.serverForm;
        if (!f.url.trim()) { this.toast(this.t("err.needUrl"), "err"); return; }
        const known = this.servers.map(function (s) { return s.id; });
        this.busy = true;
        try {
          if (f.id) await API.updateServer(f.id, f);
          else await API.addServer(f);
          const cfg = await API.config();
          this.servers = cfg.servers || [];
          if (!this.currentId) this.currentId = cfg.current || (this.servers[0] && this.servers[0].id);
          /* the entry just written: the edited id, or whatever id is new */
          const saved = f.id
            ? this.servers.filter((s) => s.id === f.id)[0]
            : this.servers.filter((s) => known.indexOf(s.id) < 0)[0];
          this.serverForm = null;
          this.toast(this.t("msg.saved"));
          if (this.currentId) await this.bootstrapServer();
          /* probe it right away so the status chip is meaningful without the
             user having to hit 测试连接 by hand after every save */
          if (saved) await this.testServer(saved);
        } catch (e) {
          if (e.status === 409) this.toast(this.t("err.duplicateServer"), "err");
          else this.toast(this.t("err.saveFailed", { v: e.message }), "err");
        } finally { this.busy = false; }
      },

      testFormServer: async function () {
        const f = this.serverForm;
        this.serverTestMsg = this.t("server.testing");
        try {
          const r = await API.testServer(f.id || "_new", f);
          const ok = r && r.ok;
          this.serverTestMsg = ok
            ? (this.t("msg.testFormOk") + (r.result && r.result.version ? " · " + r.result.version : ""))
            : this.t("msg.testFailForm", { v: (r.result && r.result.error) || "?" });
          if (ok && f.id) this.serverState = Object.assign({}, this.serverState, { [f.id]: true });
        } catch (e) {
          this.serverTestMsg = this.t("msg.testFailForm", { v: e.message });
        }
      },

      testServer: async function (s) {
        this.toast(this.t("msg.testing", { name: s.name }));
        try {
          const r = await API.testServer(s.id, {});
          const ok = r && r.ok;
          this.serverState = Object.assign({}, this.serverState, { [s.id]: ok });
          this.toast(ok
            ? (this.t("msg.testOk", { name: s.name }) + (r.result && r.result.version ? " · " + r.result.version : ""))
            : this.t("err.testFail", { name: s.name, v: (r.result && r.result.error) || "?" }),
            ok ? "" : "err");
        } catch (e) {
          this.serverState = Object.assign({}, this.serverState, { [s.id]: false });
          this.toast(this.t("err.testFailed", { v: e.message }), "err");
        }
      },

      switchServer: async function (id) {
        if (!id || id === this.currentId) return;
        try {
          await API.setCurrent(id);
          this.currentId = id;
          this.torrents = [];
          this.stats = {};
          this.selection = [];
          this.closeDetail();
          await this.bootstrapServer();
          this.toast(this.t("msg.switched"));
        } catch (e) {
          this.toast(this.t("err.switchFailed", { v: e.message }), "err");
        }
      },

      askDeleteServer: function (s) {
        const self = this;
        this.confirmBox = {
          title: this.t("server.removeTitle"),
          text: this.t("server.removeText", { name: s.name }),
          okText: this.t("server.delete"),
          onOk: async function () {
            self.confirmBox = null;
            try {
              await API.deleteServer(s.id);
              const cfg = await API.config();
              self.servers = cfg.servers || [];
              if (self.currentId === s.id) {
                self.currentId = cfg.current || (self.servers[0] && self.servers[0].id) || "";
                self.torrents = [];
                if (self.currentId) await self.bootstrapServer();
              }
              self.toast(self.t("msg.saved"));
            } catch (e) {
              self.toast(self.t("err.deleteFailed", { v: e.message }), "err");
            }
          },
        };
      },

      /* ---------------- settings ---------------- */
      loadPrefs: async function () {
        try {
          const p = await API.qb("api/v2/app/preferences");
          this.prefs = p && typeof p === "object" ? p : {};
          // the stored limit is bytes/s - show it in whichever unit is selected
          this.limitValue.dl = this.bytesToUnit(this.prefs.dl_limit, this.limitUnit.dl);
          this.limitValue.up = this.bytesToUnit(this.prefs.up_limit, this.limitUnit.up);
        } catch (e) { /* ignore */ }
      },

      bytesToUnit: function (bytes, unit) {
        const v = (Number(bytes) || 0) / (LIMIT_UNITS[unit] || 1024);
        return Number(v.toFixed(v < 10 ? 2 : 0));
      },

      unitToBytes: function (value, unit) {
        return Math.round((Number(value) || 0) * (LIMIT_UNITS[unit] || 1024));
      },

      /* Switching the unit deliberately keeps the number the user typed and
         re-interprets it ("100" then pick MB/s = 100 MB/s). Changing it the
         other way round would turn a plain 100 into 0.0977 and back again. */
      setLimitUnit: function (which, unit) {
        if (!LIMIT_UNITS[unit]) return;
        this.limitUnit[which] = unit;
      },

      applyPref: async function (key) {
        const body = {};
        body[key] = this.prefs[key];
        await this._applyPrefBody(body);
      },

      applyGlobalLimit: async function (which) {
        const key = which === "dl" ? "dl_limit" : "up_limit";
        const typed = which === "dl" ? this.limitValue.dl : this.limitValue.up;
        const bytes = this.unitToBytes(typed, this.limitUnit[which]);
        const body = {};
        body[key] = bytes;
        const ok = await this._applyPrefBody(body);
        // keep the "current:" hint honest without waiting for a full pref reload
        if (ok) this.prefs[key] = bytes;
      },

      _applyPrefBody: async function (body) {
        try {
          await API.qb("api/v2/app/setPreferences", {
            method: "POST", form: true, body: { json: JSON.stringify(body) },
          });
          this.toast(this.t("msg.applied"));
          await this.refresh();
          return true;
        } catch (e) {
          this.toast(this.t("err.applyFailed", { v: e.message }), "err");
          return false;
        }
      },

      saveSettings: async function () {
        try {
          await API.saveSettings(this.settings);
        } catch (e) {
          this.toast(this.t("err.saveFailed", { v: e.message }), "err");
        }
      },

      /* ---------------- logs ---------------- */
      loadLogs: async function () {
        try {
          const params = {};
          ["normal", "info", "warning", "critical"].forEach((k) => { params[k] = false; });
          params[this.logLevel] = true;
          const arr = await API.qb("api/v2/log/main", { params: params });
          const order = { critical: "err", warning: "warn", info: "", normal: "" };
          this.logs = (Array.isArray(arr) ? arr : []).map(function (l) {
            return { timestamp: l.timestamp, message: l.message, type: order[l.type] || "" };
          }).reverse();
        } catch (e) { this.logs = []; }
      },

      /* ---------------- backups ---------------- */
      loadBackupStatus: async function () {
        try {
          const s = await API.backupStatus();
          this.autoStatus = s || {};
          this.autoForm = {
            enabled: !!s.enabled,
            interval: s.interval_hours || 24,
            retention: s.retention_days || 30,
          };
        } catch (e) { /* keep previous values */ }
      },

      exportToFolder: async function () {
        try {
          const r = await API.backupToFolder();
          this.toast(this.t("backup.folderWritten", { path: (r && r.path) || "?" }));
          await this.loadBackupStatus();
        } catch (e) {
          this.toast(this.t("backup.exportFailed", { v: e.message }), "err");
        }
      },

      /* Click-through <a href download> is unreliable inside the fnOS phone
         WebView: blob: URLs never reach the WebView's DownloadListener, so
         the fetch+blob dance saves nothing there and the user only sees the
         success toast. Desktop browsers handle blob downloads natively and
         get the richer flow (real error toasts, no page navigation); phones
         navigate straight to the attachment URL instead, which any
         DownloadListener / system download manager can catch. */
      exportBackup: async function () {
        if (this.isMobile) {
          window.location.href = API.exportUrl;
          this.toast(this.t("backup.downloadStarted"));
          return;
        }
        try {
          const resp = await fetch(API.exportUrl, { credentials: "same-origin", cache: "no-store" });
          if (!resp.ok) throw new Error("HTTP " + resp.status);
          const dispo = resp.headers.get("content-disposition") || "";
          const m = dispo.match(/filename="?([^"]+)"?/);
          const name = (m && m[1]) || "qbpanel-backup.json";
          const blob = await resp.blob();
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url; a.download = name; a.style.display = "none";
          document.body.appendChild(a); a.click(); a.remove();
          setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
          this.toast(this.t("msg.saved"));
        } catch (e) {
          this.toast(this.t("backup.exportFailed", { v: e.message }), "err");
        }
      },

      onPickBackup: function (ev) {
        const f = ev.target.files && ev.target.files[0];
        this.backupFile = f || null;
      },

      doImport: async function () {
        if (!this.backupFile) return;
        this.busy = true;
        try {
          await API.backupImport(this.backupFile);
          this.toast(this.t("backup.importOk"));
          setTimeout(function () { location.reload(); }, 900);
        } catch (e) {
          this.toast(e.status === 400 ? this.t("backup.invalid")
            : this.t("backup.importFailed", { v: e.message }), "err");
        } finally {
          this.busy = false;
        }
      },

      /* Phone-sized label for a backup: drop the constant prefix so the
         date+time (the only part that differs) fits without ellipsis. */
      backupLabel: function (name) {
        const s = String(name || "");
        const m = s.match(/(\d{8}-\d{6}.*)$/);
        return m ? m[1] : s;
      },

      saveAuto: async function () {
        const st = this.autoStatus || {};
        const iv = Number(this.autoForm.interval) || 0;
        const rt = Number(this.autoForm.retention) || 0;
        if (iv < (st.interval_min || 1) || iv > (st.interval_max || 8760) ||
            rt < (st.retention_min || 1) || rt > (st.retention_max || 3650)) {
          this.toast(this.t("auto.rangeError"), "err");
          return;
        }
        this.settings.auto_backup_enabled = !!this.autoForm.enabled;
        this.settings.auto_backup_interval_hours = iv;
        this.settings.auto_backup_retention_days = rt;
        try {
          await API.saveSettings(this.settings);
          this.toast(this.t("auto.saved"));
          await this.loadBackupStatus();
        } catch (e) {
          this.toast(this.t("err.saveFailed", { v: e.message }), "err");
        }
      },

      runBackupNow: async function () {
        try {
          const r = await API.backupRun();
          const name = r && r.path ? String(r.path).split(/[\\/]/).pop() : "";
          this.toast(this.t("auto.ran", { name: name }));
          await this.loadBackupStatus();
        } catch (e) {
          this.toast(this.t("backup.exportFailed", { v: e.message }), "err");
        }
      },

      askRestore: function (b) {
        const self = this;
        this.confirmBox = {
          title: this.t("backup.restore"),
          text: this.t("backup.confirmRestore", { name: b.name }),
          okText: this.t("backup.restore"),
          onOk: async function () {
            self.confirmBox = null;
            try {
              await API.backupRestore(b.name);
              self.toast(self.t("backup.restoreOk"));
              setTimeout(function () { location.reload(); }, 900);
            } catch (e) {
              self.toast(self.t("backup.importFailed", { v: e.message }), "err");
            }
          },
        };
      },

      askDeleteBackup: function (b) {
        const self = this;
        this.confirmBox = {
          title: this.t("backup.delete"),
          text: b.name,
          okText: this.t("backup.delete"),
          onOk: async function () {
            self.confirmBox = null;
            try {
              await API.backupDelete(b.name);
              self.toast(self.t("backup.deleted"));
              await self.loadBackupStatus();
            } catch (e) {
              self.toast(self.t("err.deleteFailed", { v: e.message }), "err");
            }
          },
        };
      },

      /* ---------------- release check ----------------
         Fired once shortly after start-up (so the sidebar marker is already
         meaningful when the user opens the panel) and re-run on demand from
         the Update section. A failed check is not fatal: the panel keeps
         working and the section shows why it could not reach the feed. */
      /* prefer the packaged .fpk asset, fall back to the release page */
      updateAssetUrl: function () {
        const list = (this.updateInfo && this.updateInfo.assets) || [];
        const pkg = list.filter(function (a) { return /\.fpk$/i.test(a.name || ""); })[0];
        if (pkg && pkg.url) return pkg.url;
        return (this.updateInfo && this.updateInfo.html_url) || "";
      },
      updateReleaseUrl: function () {
        return (this.updateInfo && this.updateInfo.html_url) || "";
      },
      updateRepoLabel: function () {
        return (this.updateInfo && this.updateInfo.repo) || "Smi13zZ/qbpanel";
      },
      checkUpdate: async function (force) {
        if (this.updateChecking) return;
        this.updateChecking = true;
        this.updateError = "";
        try {
          const r = await API.updateCheck(!!force);
          this.updateInfo = r || null;
          if (r && r.ok === false) {
            this.updateError = this.t("update.failed", { v: r.error || "?" });
          } else if (r && r.has_update && !this._updateNotified) {
            this._updateNotified = true;
            this.toast(this.t("update.newToast", { v: r.latest }));
          }
        } catch (e) {
          this.updateError = this.t("update.failed", { v: e.message });
        } finally {
          this.updateChecking = false;
        }
      },

      /* ---------------- charts ---------------- */
      sparkTick: function () {
        const s = this.stats || {};
        if (this.view === "dash" && this.speedChart) this.speedChart.push(s.dl_info_speed || 0, s.up_info_speed || 0);
        if (this.view === "stats" && this.statsChart) this.statsChart.push(s.dl_info_speed || 0, s.up_info_speed || 0);
        this.drawCharts();
      },

      drawCharts: function () {
        // no caption inside the donut - the bare count reads cleaner centred
        // The canvas elements live inside v-if templates, so every view switch
        // hands us a brand new element - re-bind the cached chart to it first,
        // otherwise the chart keeps drawing into the detached old canvas.
        if (this.view === "dash") {
          if (this.$refs.speedCanvas) {
            if (!this.speedChart) this.speedChart = new CHART.SpeedChart(this.$refs.speedCanvas, 90);
            else this.speedChart.attach(this.$refs.speedCanvas);
            this.speedChart.draw();
          }
          if (this.$refs.donutCanvas) CHART.drawDonut(this.$refs.donutCanvas, this.statusSegments, "");
        }
        if (this.view === "stats") {
          if (this.$refs.statsCanvas) {
            if (!this.statsChart) this.statsChart = new CHART.SpeedChart(this.$refs.statsCanvas, 90);
            else this.statsChart.attach(this.$refs.statsCanvas);
            this.statsChart.draw();
          }
          if (this.$refs.statsDonut) CHART.drawDonut(this.$refs.statsDonut, this.statusSegments, "");
        }
      },
    },
  }).mount("#app");
})();
