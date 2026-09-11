# 02 — Bridge 桥接 + 初始化握手

**What to build:** 实现 Hub-Leaf 之间的 Tauri Event 桥接层。Hub 侧 BridgeOut 监听 DataBus 的 publish，通过 Tauri `emit` 广播到所有 Leaf。Leaf 侧 BridgeIn 接收 Tauri event，写入本地 DataBus。初始化握手：Leaf 发 hello 声明订阅 → Hub 收集 sticky 快照 → Hub 回 init → Leaf apply → Leaf ready。之后数据流转正常进行。

**Blocked by:** 01 — DataBus 核心 + Topic 路由 + Stream 通道

**Status:** ready-for-agent

- [ ] BridgeOut：Hub 侧监听 DataBus publish，使用 Tauri `app.emit("bridge", payload)` 广播
- [ ] BridgeIn：Leaf 侧使用 Tauri `listen("bridge")`，收到后 `dataBus.publish()` 写入本地
- [ ] hello 握手：Leaf 创建后发 hello `{ windowId, subscriptions }`
- [ ] init 响应：Hub 收集所有订阅 topic 的当前 sticky 值，一次性回推
- [ ] ready 确认：Leaf 收到 init 后逐个写入本地 Store，发 ready 确认
- [ ] Hub 维护 Leaf 订阅路由表（哪些 topic → 哪些 Leaf）
- [ ] State 通道去重：相同值连续 publish 只发一次
- [ ] `create_floating_window` 的 Rust 命令在 URL hash 中传递 IDE 端口号
