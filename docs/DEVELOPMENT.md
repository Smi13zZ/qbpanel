# 开发说明

面向想改代码或在别的飞牛设备上重新打包的人。使用说明见 [README](../README.md)。

## 架构总览

```
浏览器（Vue 3 SPA，相对路径请求 ./api/...）
        │  HTTP + JSON
        ▼
app/ui/index.cgi ── CGI 网关（桌面图标入口，反代到 127.0.0.1:<端口>）
        │
app/server/qbpanel.py ── 本地 HTTP 服务：静态文件 + 面板 API + 下载器代理
        │
app/server/backends.py ── QBClient / TRClient（Transmission 结果翻译成 qB 形状）
        │  WebAPI v2 / RPC
        ▼
qBittorrent / Transmission
```

几个关键设计：

- **前端只跟面板说话。** 浏览器不直连下载器，凭据也不下发到页面 —— 请求全部由后端代为登录与转发。
- **一种前端方言。** Transmission 的返回值在 `TRClient` 里翻译成 qBittorrent 的结构，前端不需要分支判断。
- **零第三方依赖。** 后端只用 Python 3 标准库（`urllib`、`ssl`、`http.server`、`json`）；前端 Vue 3 以本地文件形式随包分发，无 CDN。

## 目录结构

| 路径 | 说明 |
|---|---|
| `qbpanel/manifest` | 包名、显示名、版本、端口、`platform` 等元信息 |
| `qbpanel/config/{privilege,resource}` | 运行身份；应用文件夹声明 |
| `qbpanel/wizard/{install,config}` | 安装向导与应用设置向导，`field` 名即注入的环境变量名 |
| `qbpanel/cmd/main` | `start` / `stop` / `status`（status 返回 0=运行，3=未运行） |
| `qbpanel/app/server/qbpanel.py` | HTTP 服务、路由、面板 API、代理、上传 |
| `qbpanel/app/server/backends.py` | 配置存储、两个下载器客户端、备份逻辑 |
| `qbpanel/app/web/` | SPA：`index.html`、`style.css`、`js/`、`lib/vue.global.prod.js` |
| `qbpanel/app/ui/` | 桌面入口 `index.cgi` 与图标 |

## 面板 API

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/health` | GET | 版本、Python 版本、运行时长 |
| `/api/config` | GET / POST | 读取 / 保存面板设置 |
| `/api/servers` | GET / POST | 列出 / 新增下载器 |
| `/api/servers/<id>` | POST / DELETE | 修改 / 删除 |
| `/api/servers/<id>/test` | POST | 测试连接（支持尚未保存的表单） |
| `/api/current` | POST | 切换当前下载器 |
| `/api/upload` | POST | 上传 `.torrent`（原始字节） |
| `/api/backup/{status,export,to-folder,run,import,restore,delete}` | — | 备份相关 |
| `/api/qb/<path>` | 任意 | 透传到下载器（qB 走 `/api/v2/...`；Transmission 走翻译层） |

前端请求一律使用**相对路径** `./api/...`：面板在飞牛桌面里挂在 `/cgi/ThirdParty/<appname>/index.cgi/` 下，绝对路径会逃出挂载点。

## 本地开发

```bash
cd qbpanel/app/server
TRIM_PKGVAR=../../_local/var \
QBPANEL_SHARE_DIR=../../_local/share \
QBPANEL_PORT=8898 python3 qbpanel.py
# 浏览器打开 http://127.0.0.1:8898
```

源码实时生效，改完刷新即可。`_local/` 已在 `.gitignore` 中，不会误提交。

## 打包 fpk

**首选 CI**：`.github/workflows/build-fpk.yml`

- 推 `v*` 标签 → 构建 + `tools/verify_fpk.py` 校验 + 上传 artifact + 附到该标签的 Release（说明取 `CHANGELOG.md` 对应小节）
- Actions 手动 Run workflow → 只构建 + artifact，不动 Release

CI 下载官方 `fnpack-1.2.3-linux-amd64`（`https://static2.fnnas.com/fnpack/`），把 `qbpanel/` 拷到 `/tmp/build` 后统一修权限（目录 755、文件 644、`cmd/*` 与 `app/ui/index.cgi` 755）再 `fnpack build`。

**本地兜底**：`python tools/build_fpk.py` 走 `remote.py` 把源码同步到设备上打包，需要 `..\.workbuddy\scripts\remote.py` 与本机 Python 环境。

**不要在 Windows 上手工重新打 tar 包** —— 会破坏归档格式，安装时报 `code 10111`。打完用 `python tools/verify_fpk.py <file.fpk>` 自检结构：manifest 版本号与文件名一致、`cmd/*` 与 `ui/index.cgi` 可执行位、内层关键文件齐全。

## 验证脚本

`tools/*.js` 是走 CDP 的浏览器端验证脚本（真实点击 + 程序化断言），跑之前需要一个开着调试端口的无头浏览器：

```bash
# 以 9333 端口启动一个无头 Edge
"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" \
  --headless=new --remote-debugging-port=9333 --window-size=1440,900 about:blank

export NODE_PATH=<node_modules 目录>
node tools/cardshot.js http://127.0.0.1:8898
```

| 脚本 | 作用 |
|---|---|
| `docshot.js` | 生成本仓库 README / 教程用的截图（`desktop` / `mobile` 两次独立运行） |
| `cardshot.js` | 切视图后图表是否还有内容、手机卡片标题省略、`user-select` |
| `overflowshot.js` | 强制 360px 视口逐视图检测横向溢出并定位肇事元素 |
| `mobileshot.js` | 移动端布局回归（顶部切换器、底部选择器、弹窗锚定、导出下载） |
| `settingshot.js` / `round12shot.js` | 连接状态本地化、限速单位换算、tap highlight、保存后自动测试（会真的写一次下载器设置，脚本末尾会恢复） |

注意事项：

- 脚本内必须 `Network.setCacheDisabled`，否则同一浏览器会话会复用旧 CSS；
- **不要用 `Emulation.setDeviceMetricsOverride` 混测不同视口**（同一会话里 override 会跨导航残留，导致移动布局漏进桌面截图）—— 分两次运行，或干脆用 `--window-size`；
- `Page.navigate` 会清掉注入的 helper（如 `window.__set`），导航后要重新注入；
- 断言不要按界面文字定位按钮（语言可切换），用稳定 class 或序号。

## 踩过的坑（改代码前值得读）

**Vue**

- `data` 里以 `_` 开头的 key 不会暴露到模板（运行时报 `ReferenceError: _xxx is not defined`），命名别用下划线前缀。
- `v-model` 不能与依赖旧值的 `@change` 共存：`v-model` 会先改值，处理器里的「值没变就 return」会吞掉操作。统一用 `:value` + `@change`。
- 缓存的图表实例必须跟着 canvas 走：canvas 在 `v-if` 里会被销毁重建，而缓存实例仍在画那块已脱离文档的旧画布 —— 典型症状是「刚进面板正常，切走再回来空白，环形图却正常」。修法是检测 ref 变化后换绑。

**CSS**

- 表格要省略号必须 `table-layout: fixed`；`auto` + `nowrap` 会让列宽等于最长文本。
- `.field > label { display:block }` 会覆盖 `.switch { display:inline-flex }`，连带丢掉 gap 与居中。
- 内联 SVG 有基线间隙，`.ic svg` 与按钮内 svg 要 `display:block`。
- 移动端抽屉的 `z-index` 必须高于遮罩，否则按钮点不动、整页发灰。
- 安卓点按钮「闪一下蓝色」是 `-webkit-tap-highlight-color`（WebView 默认行为），不是自定义样式。

**fnOS 平台**

- 安装期间 fnOS 从暂存目录 `/vol1/appcenter-downloads/<app>-<ver>-tpk/` 调用 `cmd/main`，此刻 `shares/` 软链还没建 —— 凡是「启动时算一次」的路径都会错，必须**运行期动态解析**。
- `appcenter-cli install-fpk` 必须带 `-e <环境变量文件>`；对已安装的应用它不会升级，需先 uninstall（卸载不清空 `@appdata`）。
- 桌面入口图标要给高分辨率（`images/ICON_256.PNG`），64×64 在手机 2–3 倍屏上会糊。

**qBittorrent 5.x**

- 登录成功返回 **204**（空 body），失败是 200 + `Fails.`；
- 会话 cookie 名是 **`QBT_SID_<port>`**（4.x 为 `SID`），不能写死；
- `torrents/pause|resume` 已移除（404），改用 `torrents/stop|start`；状态名 `pausedDL/UP` → `stoppedDL/UP`，并新增 `forcedMetaDL`；
- `sync/maindata` 的 `torrents` 是 `{hash: {...}}`，内层**不含** `hash` 字段，需要自行注入；
- Python `urllib` 的响应头 key 全小写，取 `Set-Cookie` 要用大小写不敏感的容器。

## 提交规范

提交信息用「动词 + 模块 + 做了什么」，例如 `fix(mobile): 日志时间折行`、`feat(backup): 支持导出到应用文件夹`。
