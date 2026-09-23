# rss-reader — AI 排查文档

RSS/Atom 订阅查看插件。主面板 + 桌面挂件，数据存本地。

## 进程与端口

- 进程 id：`rss-server`（裸 id；全局形式 `plugin:rss-reader:rss-server`）
- 启动：`node rss-server.cjs`，`startOn: workspace_bound`
- 端口：stdout 打 `PLUGIN_PORT=<n>`；首选 8300-8699 首个可用，
  也可由宿主用 `CLAUDE_PLUGIN_PORT` 指定（测试时用过）。

## 端点

| 端点 | 用途 |
|---|---|
| `GET /api/state` | 全量状态（`{feeds, unreadTotal, lastNew, refreshMinutes, dataDir}`）—— 面板与挂件的主数据源 |
| `GET /api/health` | 存活探测 |
| `POST /api/add` | `{url}` 加源（先抓一次验证，成功才落盘） |
| `POST /api/remove` | `{id}` 删源 |
| `POST /api/refresh` | `{}` 刷新全部 / `{id}` 刷新单个 |
| `POST /api/read` | `{guid}` 标记已读 / `{all:true, feedId?}` 全部已读 |
| `POST /api/open` | `{url}` 用系统浏览器打开（见下） |
| `POST /api/config` | `{refreshMinutes}` 改刷新间隔（会重排定时器） |
| `POST /__command` | 宿主命令转发：`onInvoke: "refresh" \| "show-indicator"` |

## 几个设计决定（改代码前先读）

### 抓取为什么在进程里，不在面板 iframe

① 面板 iframe 直接 fetch 外部源会被 **CORS** 挡（源站不给跨域头）。
② 实测：`status.deepseek.com` 在**本机 curl（Windows schannel）与 Python 上 TLS 握手
失败**，而 **node 的 TLS 栈连接正常**。抓取放在 node 进程里，这两个问题一起绕开。
（排查时若看到 curl 抓不动某个源，别急着判定"源不可用"——先试 node。）

### 加源时"先抓一次"，且首次不产生新条目

`addFeed` 会先 `refreshFeed` 验证（抓不到就拒绝，不留坏订阅）。
`refreshFeed` 里对**没有 `seen` 记录**的源（= 首次抓取）只把 guid 记入已见集合、
**不生成 `lastNew`** —— 否则一装上就弹一堆"历史条目"的提醒。

### 详情用 `sandbox=""` iframe

正文是**外部 HTML**（RSS description 里带标签是常态）。空 sandbox = 最严档
（无脚本、无同源、无表单），源站内容带了脚本也执行不了。样式在 `wrapDetailHtml`
里自带（沙箱内拿不到宿主 CSS）。

### 「在浏览器打开原文」走进程

面板 iframe 是 `allow-scripts allow-same-origin`（**没有 allow-popups**），
`<a target="_blank">` 会被沙箱拦、原位导航会把面板本身替换成外网站点；
宿主的上行 kind 白名单里也**没有** open-url。所以走 `POST /api/open` —— 进程是
普通 OS 进程，调系统命令（Windows `cmd /c start`、mac `open`、linux `xdg-open`），
URL 以参数数组传递不经 shell。

### 挂件的两个坑

- **`open-indicator` 重复请求会让窗口闪**（open = 关掉重建）。挂件由**用户显式
  点击**开启，不做自动重开。面板的「桌面挂件」按钮是个开关（再点发 close-indicator）。
- **挂件靠轮询自己的进程**（`/api/state`，30s）—— 宿主不会给插件窗口推数据事件。
  这也是"新条目闪烁"的实现方式：轮询里比较**未读数是否变大**（变大才闪；初始加载
  不算，避免开窗就闪一下）。

## 挂件的透明与拖动（宿主版本相关）

- **圆角外透明**要**宿主侧**支持：`open_plugin_indicator` 建窗时 `transparent(true)`
  + URL 带 `?overlay-clear=1`（页面据此不铺底色）。两者缺一都会看到"圆角外一圈黑"——
  indicator 复用了 `#overlay/` hash 协议，而那前缀默认是**铺黑**的（给截图框选防白闪）。
  **GUI < 2026.09.20.9 的挂件是不透明的**（老版本没这两个参数），不是插件 bug。
- **拖动有两条路**，按宿主能力自动选（宿主在建窗 URL 上给 `native-drag=1` 标记）：
  1. **原生（首选）**：`pointerdown` 只上行一条 `drag-indicator`，宿主发
     `WM_NCLBUTTONDOWN + HTCAPTION` → **Windows 进入模态拖拽循环**，零 IPC、零滞后。
     拖拽期间页面收不到 pointer 事件，所以**位置靠轮询** `window.screenX/Y` 检测
     （稳定 ~800ms 即认为结束，再 POST `/api/config {widgetPos}`）。
     ⚠️ 需要 GUI ≥ 2026.09.20.10；更早的宿主没有 `drag-indicator` 这个上行 kind。
  2. **JS 回退**（老宿主 / 非 Windows）：记起始鼠标与窗口屏幕坐标，`pointermove`
     按差值发 `move-indicator`。**必须 `setPointerCapture`**（否则指针落在窗口外就
     收不到事件、拖动当场停住）；节流用 `performance.now` 而非 rAF（rAF 在页面不可见
     时暂停）。窗口位置是**物理像素**、屏幕坐标是 **CSS 像素** —— 需按
     `devicePixelRatio` 换算。
- 挂件尺寸 = 内容 340×92 + body 四边 8px padding（给投影留位；窗口透明，投影贴边会被裁）。

## 为什么挂件拖拽要走原生（踩坑记录）

窗口只有 ~356×108，而**窗口要追着鼠标跑**。走 JS 的路径是
`pointermove → postMessage → 宿主 → invoke → set_position` —— 十几到几十毫秒延迟，
窗口明显落后于鼠标。插件作者实测原话：「**拖着会经常脱离鼠标的控制、自己停下来**」。

试过的弯路：以为是指针捕获问题（加了 `setPointerCapture`）。在 Playwright 里
**测不出差异** —— 测试环境里窗口是不动的，鼠标移出 iframe 但仍在浏览器窗口内，
事件本来就不会断；而真实场景里窗口在移动、鼠标会移出**独立窗口**。
**别指望用固定窗口的浏览器测试来复现"移动中丢失输入"这类问题** —— 那是真实
窗口边界 + 窗口位移才有的行为。

## 数据文件

`<plugins-data>/rss-reader/`（安装环境：`%APPDATA%/com.claudecode.gui/plugins-data/...`；
dev 环境：从 `__dirname` 推出 `<repo>/plugins-data/rss-reader/` —— 已在 .gitignore）。

- `config.json`：`{feeds: [{id, url, title, addedAt}], refreshMinutes, widgetPos}`
- `state.json`：`{seen: {feedId: [guid]}, read: {guid:1}, cache: {feedId: {fetchedAt, items, error}}, lastNew}`

两个文件都**原子写**（`.tmp` + rename），进程被杀不会留半截 JSON。

⚠️ **多实例**（同一个 GUI 开两份 → 两个 rss-server 进程共用这两个文件）：
- `saveState` 写盘前会把磁盘上的 `read`/`seen` **并集**回来 —— 否则 B 进程会用旧内存
  抹掉 A 刚标记的已读（用户看到"已读的过一会儿又变回未读"）。
- `/api/state` 与 `refreshAll` 前会 `syncConfigFromDisk()` —— 否则 A 加的源 B 看不到
  （每个进程只在启动时读一次 config）。

## 常见问题

**面板显示「插件进程未运行」** → 去「工作进程」面板看 `rss-server` 状态。
进程只在**绑定工作区后**启动。

**某个源一直抓取失败（列表里显示 `!`）** → 悬停那个 `!` 看具体错误。
常见：链接写错 / 站点要登录 / 站点 TLS 配置特殊（换 node 试）。

**未读数不对** → `read` 集合有容量上限（3000 条），很老的已读记录会被裁剪；
裁剪后那些条目会重新变未读。这是防止 state.json 无限膨胀的取舍。

**挂件不见了** → 面板点「桌面挂件」重开，或命令面板执行「RSS：显示/收起桌面挂件」。

## 测试

`node parse.test.cjs` —— 17 条单测覆盖 RSS 2.0 / Atom 解析、实体解码（含
`&amp;` 二次解码陷阱）、CDATA、URL 安全校验、区间收敛、GBK 解码。
无外部依赖（插件包独立，不挂 vitest）。
