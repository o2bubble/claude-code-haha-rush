# PRD: GUI Service Bus — 数据协同 + 面板互操作

> 2026-07-20

## 问题

当前 GUI 各面板通过独立模块级单例（chatStore、settingsStore、layoutStore、useChatConnection）各自管理状态，缺乏统一的跨面板通信机制：

1. **状态分散**：每个 store 有自己的 subscribe，组件要订阅多个 store
2. **无法互操作**：面板 A 不能触发面板 B 的动作（如 Session 切换后自动 focus 输入框）
3. **连接管理割裂**：useChatBridge、useChatConnection 各自为政，多面板共享连接靠 ad-hoc 修 bug
4. **缺乏可见性**：没有统一的后台进程/工作线程管理页面

## 架构

```
┌─────────────────────────────────────────────────────┐
│                    Service Bus                       │
│  ┌───────────────────┐  ┌────────────────────────┐  │
│  │    EventBus        │  │   CommandRegistry      │  │
│  │  typed pub/sub     │  │   cross-panel actions  │  │
│  │  on/emit           │  │   register/execute     │  │
│  └───────────────────┘  └────────────────────────┘  │
├─────────────────────────────────────────────────────┤
│                   Services                          │
│  ┌───────────────┐  ┌─────────────┐  ┌───────────┐ │
│  │ BackendService│  │ ChatService │  │  ...       │ │
│  │ IDE 进程管理   │  │ 消息收发     │  │            │ │
│  └───────────────┘  └─────────────┘  └───────────┘ │
├─────────────────────────────────────────────────────┤
│                    Panels                           │
│  ChatMessages  ChatInput  Sessions  Files  Tasks    │
│  Settings      Toolbar    WorkerPanel (new)         │
└─────────────────────────────────────────────────────┘
```

## EventBus

### API
```ts
interface EventBus {
  on<T>(event: string, handler: (data: T) => void): () => void;   // subscribe → unsubscribe fn
  emit<T>(event: string, data: T): void;                           // fire, no subscriber = no-op
}
```

### 事件定义（类型安全）
```ts
interface GuiEvents {
  "backend.stateChanged": { status: "starting" | "running" | "stopped" | "error"; port?: number };
  "backend.portReady": { port: number };
  "chat.connected": void;
  "chat.disconnected": void;
  "chat.messageReceived": { message: ChatMessage };
  "chat.streamingChanged": { streaming: boolean };
  "session.changed": { sessionId: string };
  "settings.changed": { settings: AppSettings };
  "task.updated": { tasks: BackgroundTask[] };
}
```

### React hook
```ts
function useEvent<T>(event: string): T | undefined;           // latest emitted value + re-render on change
function useEventHandler<T>(event: string, handler: (data: T) => void): void;  // side-effect handler
```

## CommandRegistry

### 设计目的
让面板之间能触发对方的功能，而不需要互相 import。命令处理方 register，调用方 execute。

### API
```ts
interface CommandRegistry {
  register(command: string, handler: (...args: any[]) => void): () => void;
  execute(command: string, ...args: any[]): void;
}
```

### 预定义命令列表
```ts
// ── 布局 ──
"layout.toggleLeft"          // 切换左侧面板
"layout.toggleRight"         // 切换右侧面板
"layout.toggleBottom"        // 切换底部面板
"layout.expand"   (groupId)  // 展开指定 group
"layout.collapse" (groupId)  // 折叠指定 group
"layout.focus"    (groupId)  // 聚焦/激活指定 group 的 tab

// ── 聊天 ──
"chat.focusInput"            // 聚焦输入框
"chat.send"       (text)     // 发送消息
"chat.interrupt"             // 中断当前流式响应

// ── 文件 ──
"files.reveal"    (path)     // 在文件浏览器中定位文件

// ── 会话 ──
"session.switch"  (id)       // 切换到指定会话
"session.create"             // 新建会话

// ── 设置 ──
"settings.open"              // 打开设置浮窗

// ── 后端 ──
"backend.restart"            // 重启 IDE 后端
"backend.start"   (workDir)  // 启动 IDE 后端

// ── 窗口 ──
"window.toast"    (message, type)  // 弹出提示消息
```

### 使用示例
```ts
// SessionPanel 中：切换会话后 focus 输入框
function SessionPanel() {
  const handleSwitch = (id: string) => {
    switchSession(id);
    commands.execute("chat.focusInput");
  };
}

// ChatInputPanel 中：注册 focus 命令
function ChatInputPanel() {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  
  useEffect(() => {
    return commands.register("chat.focusInput", () => {
      inputRef.current?.focus();
    });
  }, []);
}
```

## BackendService

统一的 IDE 后端进程管理器，替代当前分散在 useChatConnection + settingsStore 的逻辑。

### API
```ts
interface BackendServiceState {
  status: "stopped" | "starting" | "running" | "error";
  port: number | null;
  workDir: string;
  error: string | null;
}

interface BackendService {
  getState(): BackendServiceState;
  start(workDir?: string): Promise<void>;
  stop(): Promise<void>;
  restart(workDir?: string): Promise<void>;
}
```

### 实现
- 封装当前 `useChatConnection` 中的进程发现/连接逻辑
- 封装 Rust `restart_ide_backend` / `get_ide_port` 调用
- 状态变更通过 `eventBus.emit("backend.stateChanged", ...)` 广播
- `useChatBridge` 改为监听 `"backend.portReady"` 事件而非轮询

## Worker Panel（新建）

类似 VS Code 的 Output/Problems 面板，展示后台运行状态。

### 内容
```
┌─────────────────────────┐
│ Workers             ⚙️  │
├─────────────────────────┤
│ ● IDE Backend   运行中   │  ← BackendService 状态
│   Port: 4889            │
│   CWD: /home/project    │
│                         │
│ ⏳ Agent: analyze code  │  ← 当前活跃 agent 任务
│   5 tools · 1200 tokens │
│                         │
│ ✅ Agent: fix lint      │  ← 已完成任务
│   12 tools · 3200 tok   │
└─────────────────────────┘
```

### 数据来源
- `eventBus.emit("backend.stateChanged")` → 后端状态
- `eventBus.emit("task.updated")` → 任务列表
- 可选：订阅 `eventBus` 的其他事件做日志展示

## 现有代码迁移路径

| 当前位置 | 迁到 |
|----------|------|
| `chatStore.ts` — connected, streaming, messages | → `eventBus` (事件) + `ChatService` (数据) |
| `useChatConnection.ts` — 端口发现/轮询 | → `BackendService` |
| `settingsStore.ts` — 设置存取 | → `SettingsService` + `eventBus` 广播 |
| 各 store 的 subscribe | → `useEvent()` hook |
| 组件间直接 import 函数 | → `commands.execute()` |

### 迁移策略
- **渐进式**：先建 EventBus + CommandRegistry，新功能用它，旧 store 逐步迁
- **不破坏**：旧 store 继续可用，emit 事件作为补充通知渠道
- **BackendService 先行**：这是当前最痛的点，先统一后端管理

## 文件结构

```
gui/src/services/
├── serviceBus.ts          # EventBus + CommandRegistry 实现
├── backendService.ts      # IDE 后端生命周期管理
├── events.ts              # 事件类型定义
├── commands.ts            # 命令注册中心（面板启动时注册自己的命令）
└── useService.ts          # React hooks: useEvent, useCommand
```

## 验证

1. Toolbar 点击 → `commands.execute("layout.toggleLeft")` → 左边栏切换
2. SessionPanel 切换会话 → `commands.execute("chat.focusInput")` → 输入框聚焦
3. Settings 改工作目录 → `commands.execute("backend.restart")` → 后端重启
4. BackendService 启动完成 → `eventBus.emit("backend.portReady")` → ChatMessages/ChatInput 自动连接
5. WorkerPanel 实时显示后端状态 + agent 任务
