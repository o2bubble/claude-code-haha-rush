# 03 — 聊天状态栏重构

**What to build:** 聊天面板底部状态栏显示代理状态、上下文窗口用量、实时 token 计数。

**Blocked by:** None — can start immediately

**Status:** done

- [x] 三种代理状态：未连接（红）/ 思考中（黄）/ 就绪（绿）
- [x] 上下文窗口进度条 + 百分比（绿/黄/红三色）
- [x] 实时 token 计数：输入 / 窗口上限 | 输出
- [x] 数字变化时蓝色闪烁动画（输入和输出任一变化都触发）
- [x] 后端 context_window 消息增加 output_tokens（累计值）
- [x] 修复 state.streaming 从未设为 true 的 bug
