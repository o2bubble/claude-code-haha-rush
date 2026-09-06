# GUI Server 分层重构 — 设计文档

> 日期：2026-08-27 · 状态：**已实施（Windows 验证通过）+ 2026-08-28 code-review 修正见 §11** · 关联：`gui/src-tauri`、`guis/` 数据层、跨 GUI 事件中枢
>
> 本文档固化一次 grilling 会话达成的共享理解。评审通过后才进入分阶段实现。
>
> **⚠️ 传输定案（2026-08-27 复查后修正）**：本文档下文示例写的是 gRPC/protobuf，但经核查 Rust 缺乏活跃维护的裸 TCP JSON-RPC 库、且避免 protoc 构建摩擦后，**最终定为 `jsonrpsee`（JSON-RPC 2.0）over WebSocket**。§4 的"契约"用 method / params / subscription（事件推送）表达，语义不变，仅传输与库不同。下文 gRPC/tonic/protoc 字样以本节为准确读。
>
> **⚠️ 实施偏差与 review 修正（2026-08-28）**：本文档的若干决策在实际落地时做了调整，见 **§11 实施偏差与 code-review 修正**（含 superseded 语义、自愈程度、全广播、范围扩充等）。§1-§10 保留原始设计意图，以 §11 为最终准。

## 1. 动机

当前 SQLite（plans + 超级桌面）**跑在每个 GUI 进程里**，且每个 GUI 各开一个连接到**同一工作区的同一 `data.db`**。问题：

1. **改了库不广播** —— GUI1 写入后，同工作区的 GUI2 无感知 → **两边数据对不上**（stale）。
2. **无集中管理** —— 进程/端口/数据散在各 GUI，没有一个"谁在线、谁写库"的单一视角。

**目标**：加一个 **server 中间层**，作为"数据库唯一 owner + 跨 GUI 事件中枢"，让同工作区的多个 GUI 共享同一读写通道、互相通知，并**现在就为将来"多 GUI 互发消息"预留接口与模型**。

## 2. 已对齐的关键决策

| # | 决策 | 结论 |
|---|------|------|
| 1 | server 形态 | **独立编译的 exe**（单二进制 daemon），全局唯一，**引用计数**（最后一个客户端断开后自动退出） |
| 2 | 谁负责拉起 | 先连上的 GUI **spawn 它**；其余经发现 attach（singleton-claim） |
| 3 | claude.exe | **各 GUI 自管、WS 直连**，不进 server（现用 `port:0` ephemeral，天然免碰撞） |
| 4 | gRPC 连接方 | **仅 Rust↔server**；前端走 `invoke`→Rust 不变 |
| 5 | DB 形态 | **仍"每工作区一个文件"**，server 集中开、分区隔离（复用原路径 → 老数据零迁移） |
| 6 | server 数据范围 | plans + 超级桌面（desktop_items/connections/history）；settings/MCP/guard/update **留 GUI** |
| 7 | 同步粒度 | **编辑/批次级**，不逐帧镜像；coarse 信号 + 对端 refetch + 小 debounce |
| 8 | 冲突策略 | **LWW + `updated_at` 版本戳 + `superseded` toast**（不阻塞、不丢操作、零迁移） |
| 9 | 降级 | **attach → 尝试拉起 → 本地直连降级**三级，后台**自愈重试** |
| 10 | 消息模型 | **类型化信封 + 在线注册表 + 按工作区 pub/sub**；v1 只实现 `db_changed`/`presence`；定向/回调留 stub（后期加枚举值即可） |

## 3. 架构总览

```
┌───────────┐  invoke  ┌───────────────┐   gRPC(tonic)   ┌────────────────────┐
│  GUI1 front│─────────▶│  GUI1 Rust    │───────────────▶│                    │
│  (React)   │◀──event──│  (tauri)      │                │  server.exe（全局唯一）│
└───────────┘           │               │                │  单例 daemon        │
┌───────────┐  invoke  ┌───────────────┐                │  ├─ presence 注册表  │
│  GUI2 front│─────────▶│  GUI2 Rust    │───────────────▶│  ├─ 事件信封 pub/sub │
│  (React)   │◀──event──│  (tauri)      │                │  └─ SQLite 唯一写者  │
└───────────┘           │               │                │      data.db per-ws │
                        └───────┬───────┘                └────────────────────┘
                        spawn claude.exe / WS 直连（不进 server）
```

- **server**：唯一写者（串行化 → 无 SQLite BUSY）、广播 hub、在线注册表。
- **GUI**：数据访问从"本地 SQLite"改为"gRPC 调 server"；仍自管 claude.exe；前端几乎不动。

## 4. 预留的接口模型（proto 骨架）

Package `claude_gui_server.v1`。**契约是"通用消息总线"，不是"desktop 同步器"** —— DB 同步只是其中之一。

### 4.1 事件信封（核心契约）

```proto
message Envelope {
  string client_id   // 发布者（空 = server）
  string workspace   // 工作区路由键
  string kind        // 判别联合："db_changed" | "presence" | ...（加值不加管道）
  int64  seq         // server 侧单调递增，用于去重/排序
  string ts          // 服务器时间，ISO8601
  oneof payload {
    DbChanged db_changed;
    Presence  presence;
    // 将来：GuiMessage gui_message; SessionShared session_shared; ...
  }
}

message DbChanged {
  string entity      // "desktop" | "desktop_item" | "desktop_connection" | "plan"
  string id
  string op          // "upsert" | "delete"
  string origin      // 触发写入的 client_id；GUI 据"origin == self"跳过自己的 refetch
  string updated_at  // 写入后的新版本戳
}

message Presence {
  string event       // "join" | "leave" | "update"
  ClientInfo client;
}
message ClientInfo {
  string client_id; string name; string platform;
  string workspace; string joined_at;
}
```

### 4.2 控制/数据面 RPC

```proto
service GuiService {
  // 注册 + 打开事件流（server→client server-stream 推送 Envelope）
  rpc Connect(ConnectRequest) returns (stream Envelope);

  // presence：查询某工作区在线客户端
  rpc ListClients(Workspace) returns (ClientList);

  // 数据面（desktop/plans）—— LWW + 版本戳
  rpc GetEntity(GetEntityRequest) returns (Entity);
  rpc List(Query) returns (EntityList);
  rpc Mutate(Mutation) returns (MutationResult);
}

// 预留：多 GUI 互发消息（v1 返回 Unimplemented，接口占位）
rpc SendToClient(P2PMessage) returns (Ack);      // 点对点
rpc Call(P2PRequest) returns (P2PResponse);       // 请求/响应
```

```proto
message Mutation {
  string workspace; string entity; string id;
  string base_updated_at;   // GUI 读取到的旧版本戳
  bytes  payload;           // JSON：{...待写字段}
  string origin;
}
message MutationResult {
  bool ok;
  bool superseded;          // base_updated_at < server 当前 → 已覆盖，提示
  string updated_at;        // 新版本戳
  string error;
}
```

**关键设计：给新消息类型加枚举值/oneof 变体即可，接口与管道不变。** 这就是"后期改成本低"的来源。

## 5. 数据与并发

- **每工作区一个 SQLite**：server 按 `workspace` 打开 `<workspace>/.claude/data.db`（与现 GUI `db_dir` 同路径 → 老数据直接接管，零迁移）。缺表则 `init_db`。
- **唯一写者**：所有写经 server；server 内按 workspace 加写锁，避免并发 gRPC 写导致 SQLite `database is locked`。
- **LWW**：写前比较 `base_updated_at` 与库中当前值；即便 stale 仍写入，但返回 `superseded=true`，GUI 弹轻量 toast。

## 6. 降级与自愈（决策 9）

状态机：`connected` ↔ `connecting` ↔ `local_degraded`。

- 启动/掉线：① 探测 server（发现端口）→ ② 连不上则**尝试 spawn**（抢机器级互斥锁防双启动）→ ③ spawn 失败/短时不通才 `local_degraded`（GUI 直开本地库，全功能、无同步 = 今天单实例模式）。
- 即使降级，**后台持续重试**；server 恢复 → re-attach → refetch 收敛（server 读到的文件已含降级期写入 → 不丢数据）→ 弹回 `connected`。
- **写者互斥边界**：server 活着 → 全走 gRPC；server 死 → 直写；切回时 refetch 对齐。

## 7. 发现与单例

- 固定 TCP 端口（默认 `8766`，可配）+ 机器级命名互斥锁做原子抢占（"绑定端口成功者 = server"）。
- server 写发现标记文件（含 `port/pid/started_at`），GUI 读它 attach；带 debounce 探测防启动期猛打。
- server exe 随应用打包（bundled），先连上的 GUI 以 subprocess 方式 spawn。

## 8. 实施顺序（分阶段，每阶段可验收）

1. **P0 server 骨架**：新 crate + proto（envelope/presence/connect 流）+ 单例/发现 + 编译成独立 exe。
2. **P1 数据接管**：server 开 per-workspace 库（`init_db` 复用）+ GetEntity/List/Mutate（LWW）。
3. **P2 GUI 接入**：`DbState` 换成 gRPC client，Tauri command 表面不变（前端无感）；本地降级直连。
4. **P3 同步广播**：`db_changed` fan-out + 前端 refetch + `origin==self` 跳过；`superseded` toast。
5. **P4 降级自愈**：三级降级 + 后台重试 + re-attach 收敛。
6. **P5（可选，后期）**：`SendToClient`/`Call` 实现 + 新消息 kind。

## 9. 风险与对策

| 风险 | 对策 |
|------|------|
| gRPC codegen（protoc/prost/tonic）进构建，编译时间/体积上升 | 独立 crate 隔离依赖；protoc 加入构建管线（Win/mac）；可先 `--components` 免重建 |
| GUI 启动时 server 未就绪 | `Connect` 带重试/backoff；先 spawn 后探测端口就绪 |
| 固定端口被其它应用占用 | 发现标记 + 可配端口 + 回退端口段；机器互斥锁保证唯一 |
| SQLite 并发写锁冲突 | 唯一写者 + server 内 per-workspace 写锁 |
| 通知风暴/重入（GUI 自己写又收到自己消息） | `origin==self` 跳过 refetch + seq 去重 |
| 老用户数据损坏 | 复用同路径零迁移；server 单进程 = 安全；迁移前后先备份 `data.db` |
| 工作区切换/绑定流程改走 server | GUI bind 逻辑从"开本地库"改为"assert server 可达 + 打开工作区上下文" |

## 10. 开放问题（不影响 P0-P2，实施中决定）

- server 具体 crate 位置（`gui/src-tauri/server` vs 顶层 `server/`）；schema 复用方式（复制 vs 抽共享 crate）。
- 固定端口默认值最终敲定（8766 初定）。

## 11. 实施偏差与 code-review 修正（2026-08-28）

> 本文档 §1-§10 是原始设计意图。实现阶段落地了若干**偏离原始决策**的选择（部分为有意简化、部分为用户主动追加需求），并在 2026-08-28 code-review 后修正了两处问题。以本节为最终准。

### 11.1 传输与库（最终）
- **`jsonrpsee 0.24`（JSON-RPC 2.0）over WebSocket**（见头部定案横幅），非 gRPC。
- 共享 crate **`claude-gui-shared`**（`gui/src-tauri/shared`）：`db.rs`（plans/desktops）、`note.rs`（用户级笔记）、`presence.rs`（事件信封）。GUI 的 `src/db.rs`/`src/notes.rs` 改为 re-export 薄封装。

### 11.2 实际 RPC 面（server `register_method`）
`ping` · `register_client` / `unregister_client` / `list_clients`（presence）· `mutate`（plan/desktop/delete_desktop，LWW）· `list_desktops` / `list_plans` · `send_gui_message` · `sessions_changed` / `settings_changed`（纯信号中继）· `note_create/update/delete/get/list/search/associate/disassociate/tags/get_all_tag_names/apply_tag_mapping` · `subscribe_events`（subscription，推送 `ServerEvent`）。

### 11.3 相对 §2 决策表的偏差
| # | 原决策 | 实际落地 | 说明 |
|---|--------|----------|------|
| 6 | server 数据范围 = plans + 桌面(**含 history**)；settings/MCP/guard/update 留 GUI | **笔记(用户级 notes.db)也进 server**；**settings(收藏/快捷提示/主题)经 `saveSettings` 中继广播**；`desktop_history` **仍本地** | 笔记/设置/会话列表同步是**用户主动追加**（"两个 GUI 访问同一工作区，体验不合理"）。`desktop_history` 跨端同步语义存疑，有意保留本地（共享 data.db，数据一致）。改动集中在 `lib.rs`（do_mutate + reset_server）+ `server_client.rs`（notify_*）。 |
| 7/8 | LWW + `updated_at` 版本戳 + `superseded` toast | 保留 LWW；**superseded 语义修正**：`base_updated_at` **为空视为无版本戳 → `superseded=false`** | 修正前 GUI 恒发空 base → 每次保存已存在记录都 `prior != ""` → `superseded=true` → 误弹"已被其他窗口修改"。**无 GetEntity/版本戳读取**（GUI 无 per-entity base），故 superseded 仅在有真实 base 时才有冲突提示意义；跨端一致性靠"写必落 + 对端 refetch"保证。 |
| 9 | 三级降级 attach→spawn→local + **后台持续自愈重试** | 三级降级 attach→spawn→local；**自愈为"server 断开 → `reset_server` 清缓存 + 当前调用落本地"**，下次调用重新 attach→spawn→local；**无独立后台重试循环** | 未实现"后台持续重试"，改为**失败即降级 + 下次触发收敛**（`reset_server`），实现更简单且够用。 |
| 10 | 类型化信封 + **按工作区 pub/sub** + `seq` 去重/排序 | `ServerEvent{kind}` 标记枚举（`presence`/`db_changed`/`gui_message`）；**全广播（不按工作区过滤）**；`DbChanged` **无 workspace 字段**；**无 `seq`** | **有意全广播**：笔记/设置是用户级、需跨工作区同步；跨工作区广播只是多一次无害 refetch。若按工作区过滤会破坏用户级同步。`Lagged` 事件静默丢弃（广播 channel），未做 seq 去重/排序。 |

### 11.4 code-review 修正项（commit `2e1380b`）
1. **superseded 误报**：空 `base_updated_at` → `superseded=false`（server `do_mutate`），修每次保存误弹 toast；补回归测试。
2. **server 断开自愈**：数据命令（db plan/desktop 读写删 + 全部 note 命令）的 server RPC 失败时 `reset_server` 清缓存 + 落本地；下次调用重新拉起。
3. **构建产物清理**：`gui/src-tauri/shared/.gitignore` 加 `/target`；移除误提交的 `shared/target`（cargo 构建树）。

### 11.5 实际同步覆盖（跨 GUI，同工作区/用户）
超级桌面 · 计划 · **笔记**（含 Milkdown 正文远程刷新）· **会话列表** · **收藏/快捷提示/所有设置** · 窗口可见性（离屏 -32000 自动居中 + 不持久化坏位置）。`desktop_history` / 聊天会话内容 / 布局仍未跨实例（有意）。

**§11.5 补充（2026-08-31）**：桌面 undo/redo 历史按窗口本地维护（`desktopHistoryStore` 前端模块级 `Map`，`pushSnapshot` 仅由本窗口改动触发），**不参与跨 GUI 广播**——它是"当前窗口编辑会话"的 UI 状态，每个窗口应只回退自己改的动作，共享反而会让对端"撤销我改的"。桌面**规范数据**（items/connections）已走 server 广播 + 对端 refetch 同步，undo/redo 只是其上的本地编辑层。

### 11.6 生命周期
server 引用计数 `live`（**订阅数**）→ 归零自动退出；普通 RPC 连接不占 `live`。强杀 GUI 时 WS 断开 → `sink.closed()` → live--（有测试 `server_stops_when_last_subscription_closes`）。
