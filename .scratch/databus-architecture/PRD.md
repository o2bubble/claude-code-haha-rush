# DataBus — 多窗口统一数据总线架构

## Problem Statement

当前 GUI 的通信系统完全依赖 **JS 模块级单例**（EventBus + Store），这在单窗口场景下工作正常——所有组件共享同一 JS 上下文，EventBus 的 emit/subscribe 在内存中完成。

但 GUI 已支持通过 Tauri `create_floating_window` 创建**原生子窗口**（独立的 WebView2 实例）。每个子窗口拥有独立的 JS 上下文，意味着：

1. **EventBus 隔断** — 主窗口 emit 的事件子窗口收不到
2. **Store 孤立** — 每个窗口持有独立的 Store 副本，数据永远为初始值
3. **无 WS 连接** — 子窗口不连 IDE 后端，无法收到后端消息
4. **无命令通道** — 子窗口无法执行 `cmd.send`、`cmd.interrupt` 等操作

当前 `FloatingApp.tsx` 中的子窗口只能渲染 placeholder 静态文本，完全不具备功能。要使多窗口成为一等架构，需要一套全新的跨窗口数据交互系统，且**不因多窗口引入额外的后台连接或服务负担**。

## Solution

设计 **DataBus** — 一个统一的 Topic 发布/订阅系统。每个窗口（Hub 或 Leaf）使用完全相同的 `dataBus.subscribe()` / `dataBus.publish()` API。底层根据 topic 前缀自动路由到 Stream、State、Bulk 三条通道，通过 **Tauri Event** 完成跨窗口传输。

### 核心原则

1. **Hub-Leaf 平权** — Hub 和 Leaf 窗口的组件代码完全相同，唯一的区别是 Hub 多了 WS Adapter。Leaf 不连 WebSocket，不运行任何后台服务。
2. **单 WS 连接** — 只有 Hub 连接 IDE 后端。Leaf 的所有 IO 通过 DataBus 中转。
3. **订阅驱动** — 组件声明订阅哪些 topic，生产者只负责发布。组件不关心数据来自本地 EventBus 还是远端 Bridge。
4. **通道自动路由** — 统一 API 入口，内部按 topic 前缀和 payload 大小自动选择最优传输通道。
5. **文件 I/O 各自直连** — 文件读写操作由各窗口通过 Tauri IPC 直接执行（Rust 命令对所有窗口可用），修改结果通过 `files.changed` topic 或后端 `file_edit` 事件同步。

### 架构总览

```
                    IDE Backend (唯一 WebSocket 连接)
                         │
                         │ ws://127.0.0.1:{port}/ws
                         │
             ┌───────────┴───────────┐
             │     WS Adapter         │  ← 仅 Hub 窗口
             │  订阅: cmd.*           │
             │  发布: chat.* tool.*   │
             │       terminal.*       │
             └───────────┬───────────┘
                         │ publish / subscribe
             ┌───────────┴───────────┐
             │       DataBus          │
             │    (Hub 进程内)        │
             │                       │
             │  ┌─────────────────┐   │
             │  │ Topic Router     │   │
             │  │ chat.delta.*     │→ RAF → Stream Channel
             │  │ chat.* (state)   │→ Dedup → State Channel
             │  │ cmd.*            │→ Immediate → Command Channel
             │  │ chat.session.*   │→ Chunk → Bulk Channel
             │  │ desktop.*        │→ Dedup → State Channel
             │  │ plan.* editor.*  │→ Dedup → State Channel (再视数据量决定)
             │  └─────────────────┘   │
             └───────────┬───────────┘
                         │ Tauri Event "bridge"
            ┌────────────┼────────────┐
            │            │            │
    ┌───────┴──┐  ┌──────┴──────┐  ┌─┴─────────┐
    │ BridgeIn │  │  BridgeIn   │  │ BridgeIn   │
    │ Leaf #1  │  │  Leaf #2    │  │ Leaf #3    │
    │          │  │             │  │            │
    │ DataBus  │  │  DataBus    │  │  DataBus   │
    │ Store 镜 │  │  Store 镜   │  │  Store 镜  │
    │ 像       │  │  像         │  │  像        │
    └──────────┘  └─────────────┘  └────────────┘
```

## User Stories

### 基础通信

1. 作为开发者，无论代码运行在主窗口还是子窗口，都可以用相同的 `dataBus.subscribe(topic, handler)` 订阅数据
2. 作为开发者，无论代码运行在主窗口还是子窗口，都可以用相同的 `dataBus.publish(topic, payload)` 发布数据或命令
3. 作为开发者，我不需要关心数据是如何传输的——本地事件还是跨进程 IPC，由 DataBus 内部处理
4. 作为开发者，我可以订阅通配符 topic 模式（如 `chat.*`）一次性订阅整个领域的所有事件

### 流式文本

5. 作为用户，我在子窗口查看聊天时，流式文本增量以接近实时的方式渲染，无明显延迟
6. 作为用户，我在子窗口查看终端输出时，命令输出行以接近实时的方式追加显示
7. 作为开发者，高频 topic（chat.delta.*, terminal.delta.*）自动通过 RAF 帧合并批量传输，避免 IPC 风暴

### 状态同步

8. 作为用户，子窗口打开时自动获取当前完整状态（聊天消息、plan、sessions、桌面等），无需手动刷新
9. 作为用户，主窗口切换 session、更新 plan 或修改设置后，所有子窗口同步反映变化
10. 作为开发者，sticky topic（如 `chat.streaming`）的值如果未变化则跳过发送，节省带宽

### 大负载数据

11. 作为用户，在子窗口中加载历史 session 时，即使消息数量很大也能正常显示
12. 作为用户，在子窗口中查看文件内容或 subagent 对话记录时，大文本数据通过专门通道传输
13. 作为开发者，大负载 topic 通过专门通道串行传输，不阻塞流式文本通道

### 命令执行

14. 作为用户，在子窗口的聊天输入框中发送消息，效果与在主窗口发送完全相同
15. 作为用户，在子窗口点击打断按钮，正在生成的回复立即停止
16. 作为用户，在子窗口响应权限弹窗（allow/deny/always），权限选择正确传达给后端
17. 作为用户，在子窗口切换 session、新建 session、删除 session，操作结果在所有窗口同步

### 文件操作

18. 作为用户，在子窗口中打开、编辑、保存文件，操作直接执行，结果通知所有窗口
19. 作为用户，在子窗口中浏览文件树、展开目录，操作体验与主窗口一致

### 面板操作

20. 作为用户，可以将任意面板（聊天、plan、terminal、editor 等）拖出主窗口成为原生子窗口
21. 作为用户，可以将子窗口中的面板 dock 回主窗口布局
22. 作为用户，每个窗口的布局是独立的，不相互影响
23. 作为用户，可以在子窗口中打开/关闭/切换面板，仅影响该窗口的布局

### 可靠性与清理

24. 作为系统，子窗口崩溃或关闭时，Hub 自动清理其订阅，停止向死窗口推送数据
25. 作为系统，子窗口每 5 秒发送心跳 ping，Hub 连续 3 次未收到则认为该窗口已死并清理
26. 作为开发者，子窗口重新连接时能正常恢复完整状态（重新走 init 握手）

## Implementation Decisions

### 决策 1：Hub 窗口角色

Hub 窗口是**有且仅有一个**的窗口，它拥有：
- **WS Adapter** — 唯一连接到 IDE 后端的 WebSocket
- **BridgeOut** — 管理所有 Leaf 窗口的订阅路由和生命周期
- **完整 Store** — 数据本源（所有 sticky topic 的权威值）

Hub 崩溃则所有 Leaf 失去功能——这不画蛇添足，因为 IDE 后端也在 Hub 进程管理，Hub 崩溃本身就意味着整体重启。

### 决策 2：四通道设计

根据 topic 前缀和负载特征，自动路由到四条通道：

| 通道 | 触发条件 | 传输策略 | 方向 |
|------|---------|---------|------|
| **Stream** | topic 前缀 `chat.delta.*`, `terminal.delta.*` | RAF 帧内合并同 topic payload → 每帧一次批量 emit | Hub → Leaf |
| **State** | 所有 sticky topic（`chat.message`, `plan.tasks`, `desktop.items`, `settings` 等） | 立即发送，payload hash 对比跳过相同值 | Hub → Leaf |
| **Bulk** | topic `chat.session.loaded`, `editor.fileContent`, `plan.history`, `subagents.transcript` | 一次性发送（未来可加分块） | Hub → Leaf |
| **Command** | topic 前缀 `cmd.*` | 立即发送，不合并不跳过去重 | Leaf → Hub → 执行者 |

### 决策 3：Store 镜像模型

Leaf 窗口不运行真实 Store 逻辑。每个 Store 对应一个**镜像 store**—只持有最近数据副本，通过 patch 更新：

```ts
type Patch = {
  topic: string;
  value: unknown;
  mergeId?: string;   // 相同 topic 下用于去重的消息 ID
};
```

Leaf 收到 Bridge 推送后：
1. 写入本地镜像 store
2. 触发本地 EventBus（仅本窗口内 React 渲染用）
3. 组件通过 `dataBus.subscribe()` 获取数据（内部从 EventBus 读）

### 决策 4：topic 树

```
chat.delta.text          ← Stream, RAF 拼接
chat.delta.thinking      ← Stream, RAF 拼接
chat.delta.json          ← Stream, 保留最后
chat.message             ← State, sticky
chat.streaming           ← State, sticky (bool)
chat.connected           ← State, sticky (bool)
chat.context             ← Stream, 保留最后
chat.model               ← State, sticky
chat.sessions            ← State, sticky
chat.activeSession       ← State, sticky
chat.tasks               ← State, sticky
chat.slashCommands       ← State, sticky
chat.inputBlocked        ← State, sticky
chat.skills.dialog       ← State, sticky
chat.session.loaded      ← Bulk (消息历史，100KB-5MB)

tool.progress            ← Stream, 保留最后
tool.use                 ← State, sticky
tool.result              ← State, sticky
tool.permission          ← State, sticky

terminal.delta.output    ← Stream, 逐行拼接
terminal.output          ← State, sticky (完整输出)

plan.tasks               ← State, sticky
plan.history             ← Bulk, 按需分页

subagents.list           ← State, sticky
subagents.transcript     ← Bulk, 按需加载

editor.tabs              ← State, sticky
editor.activePath        ← State, sticky
editor.fileContent       ← Bulk, 按需加载

files.changed            ← State, 文件系统变更通知

desktop.list             ← State, sticky
desktop.items            ← State, sticky (可能到 ~100KB)
desktop.selected         ← State, sticky

settings                 ← State, sticky
workers.status           ← State, sticky
status.messages          ← State, sticky

# 命令类 topic (全走 Command 通道，Leaf → Hub)
cmd.send
cmd.interrupt
cmd.compact
cmd.permission.respond
cmd.session.switch
cmd.session.new
cmd.session.delete
cmd.task.kill
cmd.subagent.transcript
cmd.plan.history.load
cmd.editor.open
cmd.editor.save
cmd.editor.close
cmd.desktop.item.*
cmd.desktop.create
cmd.desktop.delete
cmd.desktop.connect
cmd.desktop.disconnect
cmd.desktop.undo
cmd.desktop.redo
```

### 决策 5：Stream 通道合并策略

每帧（`requestAnimationFrame`）合并一次。若当前帧无数据则不 emit。

| topic | 合并方式 |
|-------|---------|
| `chat.delta.text` | 拼接所有 text，保留最大 index |
| `chat.delta.thinking` | 拼接所有 text，保留最大 index |
| `chat.delta.json` | 保留最后一条（partial_json 是累积替换） |
| `terminal.delta.output` | 保留最后一条输出 |
| `tool.progress` | 保留最后一条，追加输出长度 |
| `chat.context` | 保留最后一条 |

### 决策 6：初始化握手

```
Leaf 创建:
  1. Leaf → Hub: Bridge hello { windowId, subscriptions: ["chat.*", "plan.tasks", ...] }
  2. Hub: 收集所有订阅 topic 的当前 sticky 值
  3. Hub → Leaf: Bridge init { snapshots: { topic → stickyValue } }
  4. Leaf: 逐个 bus.publish(topic, stickyValue) → 写入本地 Store
  5. Leaf → Hub: Bridge ready
  6. 之后 Stream/Bulk 通道正常流转
```

### 决策 7：命令执行分工

| 命令 | 执行者 | 原因 |
|------|--------|------|
| `cmd.send`, `cmd.interrupt`, `cmd.compact`, `cmd.permission.respond` | Hub WS Adapter | 只有 Hub 连 WS |
| `cmd.session.*`, `cmd.task.kill`, `cmd.subagent.transcript`| Hub WS Adapter | 只有 Hub 连 WS |
| `cmd.editor.open`, `cmd.editor.save`, `cmd.editor.close` | 各自窗口 Tauri IPC | 文件 I/O 各窗口可直接调用 Rust 命令 |
| `cmd.plan.history.load` | Hub Tauri IPC | SQLite 在 Hub 进程 |
| `cmd.desktop.*` | Hub Store mutation | 数据本源在 Hub，MCP 也绑定 Hub |
| `cmd.skill.open` | 各自窗口 UI | 仅影响本窗口布局 |

### 决策 8：心跳与清理

```
Hub 每 5 秒向所有 Leaf 发送 ping
Leaf 每收到 ping 立即回复 pong
Hub 连续 3 次 (15 秒) 未收到 pong → 清理该 Leaf 订阅 →停止推送
```

清理后若 Leaf 仍在运行（网络延迟恢复），Leaf 会发现 pong 得不到 ping 回复，主动重连（重新走 hello→init→ready）。

### 决策 9：命令乐观更新

Leaf 发送 `cmd.interrupt` 后：
1. Leaf 本地**乐观设置 `chat.streaming = false`**（即时 UI 反馈）
2. Hub → WS → 后端 → 通过 WS 广播 `chat.streaming = false` + 截断的 assistant message
3. 所有窗口（包括 Leaf）收到权威更新 → 若已乐观设置则幂等跳过

乐观更新仅用于 `interrupt` 和 `send`（预插入 user message）。其他命令（session 操作、权限响应等）等后端确认。

### 决策 10：消息去重

每条跨窗口消息携带 `mergeId`（Hub 全局递增序号）。Leaf 记录每个 topic 最后收到的 mergeId。重连恢复时，Hub 可减少重复发送。

### 决策 11：现有系统迁移

- **EventBus** — 保留，但角色从「跨面板通信」降级为「进程内通信」。DataBus 在单窗口内直接调用 EventBus emit（无需 IPC）。
- **Store** — 保留现有 module 单例结构。Hub 侧 Store 不变。Leaf 侧 Store 改为镜像模式，通过 DataBus 同步。
- **useChatBridge** — 仅 Hub 运行。Leaf 侧不运行。
- **useService hooks** — 接口不变（`useEvent` / `useEventHandler` / `useCommand`），内部改为从 DataBus 读取。

## Testing Decisions

### 测试策略

- **仅测试外部接口行为** — DataBus 的 `subscribe`/`publish` API 和初始化握手流程，不测试内部通道实现细节
- **mock Tauri Event** — 用 mock 的 `emit`/`listen` 替代真实的 Tauri 事件系统
- **mock WebSocket** — 用 mock WS server 验证 Hub WS Adapter 的消息转发
- **组件集成测试** — 验证 Leaf 窗口组件能正确渲染从 DataBus 收到的数据

### 测试场景

| 测试 | 验证内容 |
|------|---------|
| DataBus 基础 | subscribe 后 publish 能收到对应 topic 的数据 |
| 通配符订阅 | `chat.*` 能收到 `chat.message`、`chat.streaming` 等所有子 topic |
| Stream 合并 | 同一帧内 10 个 delta → Leaf 只收到 1 次 translate emit |
| State 去重 | 相同值连续 publish 2 次 → Leaf 只收到第 1 次 |
| 初始化握手 | Leaf 发 hello → Hub 回 init 带完整快照 → Leaf ready |
| 命令执行 | Leaf publish cmd.interrupt → Hub WS 收到 message |
| 心跳清理 | 连续 3 次无 pong → Hub 停止向该 Leaf 推送 |
| 乐观更新 | Leaf publish cmd.interrupt → 本地 streaming 立即变 false → 后端确认后不变 |

### 测试数据量级

| 场景 | 测试数据规模 |
|------|------------|
| 正常聊天 | 20 条 messages |
| 大负载 init | 1000 条 messages (模拟高负载 session) |
| 文件内容 | 10KB 文件 |
| 流式并发 | 同一帧内 50 个 delta（模拟后端快速吐 token） |

## Out of Scope

1. **多 Hub 窗口** — 当前一个会话只有一个 IDE 后端连接。多 Hub 意味着多后端，不在本次范围
2. **Bulk 分块传输** — 一次性发送，先确认 Tauri Event 存在硬限制后再实现分块
3. **跨会话状态持久化** — DataBus 的订阅/路由状态不持久化到 SQLite，每次启动重建
4. **WebSocket 多客户端并发** — Hub WS Adapter 维持现有单连接逻辑，不改造后端
5. **Super Desktop 的 MCP 服务在 Leaf 窗口的暴露** — MCP 只在 Hub 运行，Leaf 不启动 MCP
6. **面板布局跨窗口迁移** — 每个窗口的布局独立管理，不实现「将布局从一个窗口同步到另一个」
7. **Leaf 窗口离线缓存** — Leaf 关闭后不保留状态，重新打开从头握手
8. **真正的双向 WebRTC/Streaming 协议** — 不替换底层的 Tauri IPC，继续使用 Tauri event 作为传输

## Further Notes

### 与现有 EventBus 的关系

DataBus 不取代 EventBus，而是包裹它。在单窗口内的调用链：

```
组件 → dataBus.subscribe("plan.tasks", fn)
     → DataBus (检测到这是 local-only topic)
     → eventBus.on("PLAN_UPDATED", fn)
```

跨窗口调用链：

```
Leaf 组件 → dataBus.publish("cmd.interrupt")
          → DataBus (检测到 cmd.* → Command Channel)
          → Tauri emit("bridge", { topic, payload })
          → Hub BridgeOut → dataBus.publish("cmd.interrupt")
          → WS Adapter → ws.send({ type: "interrupt" })
```

### Stream 通道性能预估

假设后端每秒吐出 60 个 token（~60 个 delta 事件），RAF 合并后每帧最多一次 emit。60fps 下，子窗口每秒最多收到 60 条 IPC，每条 batch 含 1-3 个 delta。这是完全可接受的。

对比不合并的情况（每个 delta 一次 IPC）：60 × 60 = 3600 次 IPC/秒，必然是灾难。

### 渐进式迁移路径

1. **Phase 1** — 实现 DataBus 核心 + Hub-Leaf 桥 + ChatMessages 面板在 Leaf 可用
2. **Phase 2** — ChatInput / SessionPanel / PlanPanel / TasksPanel 迁入
3. **Phase 3** — Terminal / Editor / FileBrowser 迁入
4. **Phase 4** — SubAgent / SuperDesktop / Settings / Workers 迁入
5. **Phase 5** — 现有 CSS 浮动面板（AskQuestionFloating、SkillDialogFloating）改为 Tauri 原生窗口

### Phase 1 验证标准

- 从主窗口右键 tab 打开 ChatMessages 到子窗口
- 子窗口能看到当前聊天消息
- 发送消息后子窗口能显示流式回复
- 点击打断能正常停止生成
- 切换 session 后子窗口消息列表同步更新
