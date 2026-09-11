# 1 字节覆写 Bug 排查记录

## 现象

Claude Code (claude.cmd) 通过 FileWriteTool 写入 HTML 文件后（例如 33KB），文件先正确落盘，随后被覆写为 **1 字节**。Open Design 桌面客户端的预览界面显示空白。

## 环境

- **Claude Code**: claude-code-haha fork (local repo)
- **Open Design**: 开源版 (github.com/nickspaargaren/open-design) Windows 桌面客户端 (Electron)
- **运行时**: Bun
- **平台**: Windows 11

## 排查历程

### Phase 1: 怀疑原子写入 (atomic write)

最初怀疑是 Claude Code 的原子写入模式（写 `.tmp` + `rename`）导致文件系统 watcher 在 rename 瞬间读到空文件。

**修复**: 引入 `CLAUDE_CODE_SAFE_WRITE=1` 环境变量，跳过原子写入，改为直接 `writeFileSync` + 大小验证重试。

**结果**: 问题依旧。说明不是原子写入的问题——文件确实写对了（33KB），但**写入后被覆写**了。

### Phase 2: 怀疑 Open Design 文件 watcher

分析 Open Design daemon 源码：

- `apps/daemon/src/project-watchers.ts`: 使用 **chokidar** 监听项目目录文件变化
- `awaitWriteFinish`: `{ stabilityThreshold: 200, pollInterval: 50 }` — 文件稳定 200ms 后才触发事件
- watcher 触发 `file-changed` 事件 → SSE 广播到 web UI

chokidar 本身只读不写，不是问题来源。

### Phase 3: 定位根因 — persistArtifact 竞态

在 `apps/web/src/components/ProjectView.tsx` 中发现关键代码：

**第 1425-1458 行** — SSE 流监听 FileWriteTool 的 tool_use/tool_result，自动打开预览：

```typescript
// Track Write tool invocations so we can auto-open the destination
// file the moment the agent finishes writing it.
if (ev.kind === 'tool_use' && (ev.name === 'Write' || ev.name === 'Edit')) {
  pendingWritesRef.current.set(ev.id, filePath);
}
if (ev.kind === 'tool_result') {
  const filePath = pendingWritesRef.current.get(ev.toolUseId);
  if (filePath && !ev.isError) {
    void refreshProjectFiles().then((nextFiles) => {
      const decision = decideAutoOpenAfterWrite(filePath, nextFiles);
      if (decision.shouldOpen && decision.fileName) {
        requestOpenFile(decision.fileName);
      }
    });
  }
}
```

**第 1561-1567 行** — 流结束时，把 `<artifact>` 标签内容再次写入项目目录：

```typescript
// Persist the finished artifact to the project folder so it shows
// up as a real tab (not just the synthetic "live" stream).
setArtifact((prev) => {
    if (!prev || !prev.html) return prev;
    void persistArtifact(prev);  // 可能覆盖已写入的文件！
    return prev;
});
```

**第 1773-1863 行** — `persistArtifact` 的实现：

```typescript
const persistArtifact = useCallback(async (art: Artifact) => {
  // ...
  const existing = new Set(projectFiles.map((f) => f.name));
  let fileName = `${baseName}${ext}`;
  let n = 2;
  while (existing.has(fileName) && savedArtifactRef.current !== fileName) {
    fileName = `${baseName}-${n}${ext}`;
    n += 1;
  }
  // ...
  const file = await writeProjectTextFile(project.id, fileName, art.html, {
    artifactManifest: manifest ?? undefined,
  });
  // 写入后自动打开预览
  if (file) requestOpenFile(file.name);
});
```

### Bug 触发序列（竞态条件）

```ascii
时间线:
t=0.00  FileWriteTool.writeTextContent() → file.html (33KB)
t=0.01  Safe write 验证通过 ✓
        |
t=0.05  SSE: tool_result 事件到达 web UI
t=0.06  → refreshProjectFiles() 开始 (异步)
t=0.06  → requestOpenFile('file.html') → 预览打开 (正确)
        |
t=0.10  SSE: 流结束 → persistArtifact() 开始
t=0.11  → 检查 projectFiles (← 尚未刷新! 看不到 file.html)
t=0.12  → 认为文件名可用 → POST /api/projects/:id/files
t=0.15  → daemon writeProjectFile() 覆写 file.html
t=0.16  文件变成 artifact 的占位内容 (可能是 '\n' = 1 byte) ‼️
        |
t=0.20  refreshProjectFiles() 完成 (晚了，文件已损坏)
```

**关键**: `persistArtifact` 依赖 React state `projectFiles` 来判断文件名是否冲突。但 `refreshProjectFiles()` 和 `persistArtifact()` 是并发执行的，后者可能先完成，此时 `projectFiles` 还没包含 FileWriteTool 刚写的文件。

### 为什么禁用"自动预览"能缓解

因为禁用后，代码很可能不会进入触发 `persistArtifact` + `requestOpenFile` 的路径，或者改变了时序使竞态条件不再容易触发。

## 修复方案

### 方案一（已实施）：在 Claude Code 侧加后写保护

**位置**: `src/tools/FileWriteTool/FileWriteTool.ts`

**逻辑**:
1. `writeTextContent()` 完成且安全写入验证通过后
2. 等待 **800ms**（覆盖 chokidar 200ms + SSE 传播 + persistArtifact 的时序窗口）
3. 检查文件大小是否仍然正确（≥ 预期大小 50%）
4. 若被截断 → 重新写入，再等 800ms 确认
5. 最多重试 2 轮，最大延迟约 1.6s

**优点**: 不改 Open Design 代码，对用户透明
**缺点**: 每次 FileWriteTool 调用增加 ~800ms 延迟（仅 `CLAUDE_CODE_SAFE_WRITE=1` 时）

### 方案二（未实施，推荐上游修复）：在 Open Design 侧修复

在 `persistArtifact()` 写入前，通过 daemon API 确认目标文件**在磁盘上**不存在，而非依赖 React state：

```typescript
// 先通过 API 确认文件在磁盘上不存在
const fileExists = await checkFileExists(project.id, fileName);
if (fileExists) {
  fileName = `${baseName}-${n}${ext}`;
  n++;
}
```

## 关键文件索引

### Claude Code
| 文件 | 用途 |
|------|------|
| `src/tools/FileWriteTool/FileWriteTool.ts` | FileWriteTool 实现，内含后写保护 |
| `src/utils/file.ts` | `writeFileSyncAndFlush_DEPRECATED` 安全写入逻辑 |

### Open Design
| 文件 | 用途 |
|------|------|
| `apps/web/src/components/ProjectView.tsx` (L1425-1458) | Write tool 检测 + 自动打开预览 |
| `apps/web/src/components/ProjectView.tsx` (L1561-1567) | 流结束后 persistArtifact |
| `apps/web/src/components/ProjectView.tsx` (L1773-1863) | persistArtifact 实现 |
| `apps/daemon/src/project-watchers.ts` | chokidar 文件监听 (awaitWriteFinish=200ms) |
| `apps/daemon/src/project-routes.ts` | POST /api/projects/:id/files 写入端点 |
| `apps/daemon/src/projects.ts` | writeProjectFile 函数 |
| `apps/daemon/src/claude-stream.ts` | Claude Code JSONL 流解析 |

## 经验教训

1. **原子写入不是问题的根本原因** — 不要过早下结论，确认文件是"写入错误"还是"写入后被覆写"
2. **agent 的说法可能有误导** — agent 说"33KB 完整落盘"只是确认了写入成功，不代表文件没有被后续操作覆写
3. **看代码要追到完整的调用链** — 只看 Claude Code 侧写文件是不够的，要理解下游消费者（Open Design）在文件写入后做了什么
4. **竞态条件的线索** — "先正确后变 1 字节" + "不让 agent 打开预览就不触发" 高度指向竞态条件
5. **在你自己能控制的地方修** — 不要依赖下游项目的修复（你控制不了它们的发布周期）
