// ── 聊天挂件（纯挂件模式）──
//
// 半透明、置顶、无边框、可拖的小窗，只显示当前会话最近几条消息 + 输入框，
// 能完成基本对话。**不提供会话切换**（跟随主窗当前会话）。
//
// 数据从哪来：本窗是 **leaf**（见 bridge.detectRole 的 widget 分支）—— 它没有后端
// WS，全部聊天数据靠 DataBus 从主窗镜像（`bridge.startLeaf` + `startCrossWindowBusLeaf`），
// 与浮窗同一套机制。
//
// 🔴 **铁律：不要调用 `chatSession.sendMessage()`**。
// 本窗的 chatSession 处于 leaf 态（ws === null），调它会**本地** addMessage 并上行
// `cmd.user`，而主窗收到后又 addMessage 一次（不同 uuid，id 去重拦不住）→ 同一条话
// 出现两个气泡、两个窗口状态分叉。正确做法是只 publish `cmd.user`，让**主窗当唯一
// 写者**，气泡再经 `chat.message` 镜像回来（这样退出挂件回主窗后历史也完整）。
//
// 主窗的显示/隐藏由 Rust 侧负责（open/show/close_chat_widget 与窗口销毁回调）。

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { bridge } from "../../services/bridge";
import { startCrossWindowBusLeaf } from "../../services/crossWindowBusLeaf";
import { crossWindowBus } from "../../services/crossWindowBus";
import { useEvent } from "../../services/useService";
import { Events, type ChatStateChangedPayload } from "../../services/events";
import { getSettings } from "../../stores/settingsStore";
import { normalizeTheme } from "../../utils/themeUtils";
import { InputArea } from "../chat/InputArea";
import { WidgetMessageList } from "./WidgetMessageList";
import { t } from "../../i18n";
import { X, ExternalLink } from "lucide-react";

/**
 * 向主窗要多少条历史。
 *
 * 取 12 而非更多：挂件高度约 560px，而一条 assistant 回复常带 markdown（几百 px）。
 * 要太多了反而一进来就停在"很久以前"，用户还得往下滚才能看到最新 —— 与"只看近期几条"
 * 的初衷相反。（实测反馈：20 条时首屏半屏是旧内容。）
 */
const HISTORY_LIMIT = 12;
/** 自驱心跳间隔（见 bridge.selfPong 的注释：主窗隐藏后不能指望它按时 ping）。 */
const HEARTBEAT_MS = 5000;

export default function WidgetApp() {
  const state = useEvent<ChatStateChangedPayload>(Events.CHAT_STATE_CHANGED)?.state;
  const [ready, setReady] = useState(false);
  const askedRef = useRef<string | null | undefined>(undefined);

  // ── 启动：叶桥 + 历史回填 + 主题 + 亮窗 ──
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // 订阅面：聊天 + 设置 + **widget.***（历史回填的应答 topic）。
      //
      // ⚠️ **`"widget.*"` 不能漏**（2026-09-22 排查很久的真因）：桥接的定向投递
      // 会先按 leaf 的订阅 pattern 过滤（`bridgeOut` → `shouldForwardTo`），
      // 没订阅的 topic **根本不发**。挂件要 `widget.history`（历史回填的应答），
      // 但订阅面里没有 `widget.*` → 应答被静默丢掉 → 表现为"hub 说发了 4 条、
      // 挂件一条没显示"。hub 侧日志看不出异常（它以为发出去了）。
      //
      // （顺带修正：原 `"worker*"` 不是合法 pattern —— 匹配规则只认精确、
      //   `*`、或 `前缀.*`；缺了点号的写法永远匹配不上。挂件只用 chat/settings。）
      const subs = ["chat.*", "settings", "widget.*"];
      await bridge.startLeaf(subs);
      if (cancelled) return;
      startCrossWindowBusLeaf(subs);

      // 主题与字号：挂件是独立 document，没人给它打标（App.tsx 那套不在这跑）。
      // settings 是 sticky topic，握手快照里就有；取不到也只是浅色一瞬。
      try {
        document.documentElement.dataset.theme = normalizeTheme(getSettings().theme);
        const fs = getSettings().uiFontSize ?? 100;
        document.documentElement.style.setProperty("--font-scale", (fs / 100).toFixed(2));
      } catch { /* 设置没到 → 用默认主题 */ }

      setReady(true);
      // 就绪后才亮挂件 + 藏主窗（Rust 内是原子的：先 show 挂件再 hide 主窗）
      void invoke("show_chat_widget").catch(() => {});

      // 历史回填：sticky 的 chat.message 只留最后一条，必须主动要一次。
      // （细节与理由见 crossWindowBusHub 里 widget.history.request 的注释。）
      //
      // ⚠️ **必须等 onLeafReady**（= hub 已发来 init，说明本窗已注册进它的 leaf 表）。
      // 在这里（mount 时）直接发请求的话，会跑在 hello 被 hub 处理之前 —— 那时
      // 遍历 leaf 表还找不到本窗，应答**发不出去**，窗口就永远是空的
      // （2026-09-22 用户实测："退出挂件再进来，消息列表是空的"）。
      bridge.onLeafReady(() => {
        console.log("[widget] 桥接就绪，请求历史");
        crossWindowBus.publish("widget.history.request", { limit: HISTORY_LIMIT });
      });
    })();

    // 自驱心跳 —— 换取主窗隐藏后的存活
    const hb = setInterval(() => { void bridge.selfPong(); }, HEARTBEAT_MS);

    return () => {
      cancelled = true;
      clearInterval(hb);
      // ⚠️ **这里刻意什么都不做**（不清 leaf 状态、不发 goodbye）。
      //
      // 曾经的写法在这里调 `bridge.resetLeaf()` + `sendGoodbye()`，结果**制造了**
      // 两个用户可见故障（2026-09-22 实测"历史没加载 + 消息重复"）：
      // React StrictMode 的**假卸载**（mount→unmount→mount）也会跑到这里 →
      // 清掉 `_leafStart`/`_initApplied` 守卫 → 第二次 mount 重新 hello →
      // hub 回第二次 init → 快照**又应用一遍**（累加型 delta 直接表现为文本重复）；
      // 且 goodbye 与 hello 竞态，可能把刚注册的 leaf 删掉 → 窗口收不到数据。
      //
      // 不需要重置的真正原因：**关闭挂件会销毁并重建整个 webview**（重开时 console
      // 会重新打印 `Connected as ...`），JS 模块状态本来就是全新的。
      // （早先我以为"同进程共享 WebView2 数据目录 → 模块状态残留"，那是错的 ——
      //   数据目录只是磁盘缓存，与 JS 内存状态无关。）
    };
  }, []);

  // ── 跟随主窗的会话切换 ──
  // 挂件不提供切换入口，但主窗切了会话，这里要重新拉一次历史（否则显示的是旧会话的消息）
  const sessionId = state?.sessionId ?? null;
  useEffect(() => {
    if (!ready) return;
    if (askedRef.current === sessionId) return;
    askedRef.current = sessionId;
    // ⚠️ 同样要等桥接就绪 —— 见启动 effect 里的注释（否则请求可能跑在 hello 之前）
    bridge.onLeafReady(() => {
      crossWindowBus.publish("widget.history.request", { limit: HISTORY_LIMIT });
    });
  }, [ready, sessionId]);

  // ── 发送 / 打断：只上行，不本地写（见文件头铁律）──
  const onSend = useCallback((content: string) => {
    const c = content.trim();
    if (!c) return;
    crossWindowBus.publish("cmd.user", { content: c });
  }, []);
  const onInterrupt = useCallback(() => {
    crossWindowBus.publish("cmd.interrupt", {});
  }, []);

  const streaming = !!state?.streaming;
  const messages = state?.messages ?? [];

  return (
    <div
      style={{
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        // 几乎不透明（0.97）——**可读性优先于"透明观感"**。
        //
        // 试过 0.78 / 0.93 + backdrop-filter：桌面上的正文字号与挂件接近，透上来就是
        // "两层文字叠在一起"，小窗里根本没法读（用户实测反馈）。而 backdrop-filter
        // 在本窗**实际无效** —— 窗口背后是**另一进程**的像素（DComp 合成路径），
        // 拿不到可模糊的内容（截图佐证：0.93 下桌面文字仍清晰透出，说明没在模糊）。
        //
        // 结论：透明留给"窗口形状"（圆角、无边框、置顶、可拖），底色做实心。
        // 只留 3% 让它在边缘处隐约透出桌面，维持"浮着"的观感。
        //
        // ⚠️ 底色**用主题变量**而不是硬编码色值：挂件的文字全部来自主题变量
        // （--fg-primary 等），底色若与主题脱钩，换主题后就会"文字和背景撞色"
        // （dark 主题下 --fg-primary 是 #cdd1da 亮灰，配硬编码的深蓝底本就够看；
        // 但浅色主题下会直接变成浅字浅底，完全不可读）。
        backgroundColor: "color-mix(in srgb, var(--bg-root) 97%, transparent)",
        border: "1px solid var(--border-medium)",
        borderRadius: 12,
        overflow: "hidden",
        color: "var(--fg-primary)",
        fontFamily: "var(--font-sans)",
        boxSizing: "border-box",
      }}
    >
      {/* 拖动条 —— 用 data-tauri-drag-region（非 deep）：只有直接按住这里才拖，
          输入框/按钮区域不会被拖拽吞掉点击 */}
      <div
        data-tauri-drag-region
        style={{
          height: 30,
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "0 8px 0 12px",
          fontSize: 11,
          // 提亮：--fg-muted 在深底上偏暗，11px 小字更是糊成一团（可读性实测反馈）
          color: "var(--fg-secondary)",
          cursor: "grab",
          userSelect: "none",
        }}
      >
        <span data-tauri-drag-region style={{ flex: 1 }}>
          {t("widget.title")}
        </span>
        {state?.inputBlockedReason && (
          // 权限确认等弹窗渲染在（隐藏的）主窗里 —— 用户会以为"卡住了"。
          // 这里给一条出路：切回主窗去处理，处理完可以再点挂件回来。
          <button
            type="button"
            title={t("widget.backToMainHint")}
            onClick={() => void invoke("focus_main_window").catch(() => {})}
            style={barBtnStyle}
          >
            <ExternalLink size={11} />
            {t("widget.backToMain")}
          </button>
        )}
        <button
          type="button"
          title={t("widget.exit")}
          onClick={() => void invoke("close_chat_widget").catch(() => {})}
          style={barBtnStyle}
        >
          <X size={12} />
        </button>
      </div>

      {/* 消息区 */}
      <WidgetMessageList messages={messages} streaming={streaming} />

      {/* 输入区 —— 复用 InputArea（props 全受控、无布局依赖）。
          外层覆写几个 CSS 变量让它融进半透明底，**不改它一行代码**。 */}
      <div
        style={{
          flexShrink: 0,
          // 让 InputArea 融进挂件底：它是按"面板"设计的（自己带一层 bg-root 底色与
          // 边框），在挂件里要变成"同一张卡片的一部分"，所以把它的底色抹掉、边框调淡，
          // 并**提亮提示文字**（--fg-muted 在深底上偏暗，placeholder/提示行会糊）。
          "--bg-root": "transparent",
          "--bg-surface": "rgba(255,255,255,0.06)",
          "--border-light": "rgba(255,255,255,0.14)",
          "--fg-muted": "var(--fg-secondary)",
        } as React.CSSProperties}
      >
        <InputArea onSend={onSend} onInterrupt={onInterrupt} streaming={streaming} />
      </div>
    </div>
  );
}

const barBtnStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 3,
  border: "none",
  background: "none",
  cursor: "pointer",
  // 同拖动条：10px 小字 + --fg-muted 在深底上几乎看不见
  color: "var(--fg-secondary)",
  fontSize: 10,
  padding: "2px 5px",
  borderRadius: 4,
  fontFamily: "var(--font-sans)",
};
