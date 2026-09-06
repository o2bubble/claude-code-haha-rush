import React, { useState, useEffect, useRef, useCallback } from "react";
import { getChatState } from "../../stores/chatStore";
import { useChatBridge, requestPluginRefresh } from "./useChatBridge";
import { InputArea } from "./InputArea";
import { TasksPanel } from "./TasksPanel";
import { useBackend } from "../../services/backendService";
import { useEvent } from "../../services/useService";
import { Events, type ChatStateChangedPayload } from "../../services/events";
import { MsgQueuePanel, MsgQueueFooterCapsule, useQueuePosition, useMsgQueueCollapse } from "./MsgQueuePanel";
import { eventBus } from "../../services/serviceBus";
import { useT, t } from "../../i18n";
import { addFloatingPanel, removeFloatingPanel, getFloatingPanels, bringFloatingToFront, findTabByPanelId, ensureGroupVisible, setActiveTab } from "../../stores/layoutStore";
import { setAskQuestionCallbacks, clearAskQuestionCallbacks } from "./AskQuestionFloating";
import { routeCommand } from "../../utils/commandRouter";
import { getSettings, type AppSettings } from "../../stores/settingsStore";
import { addStatusMessage } from "../../stores/statusMsgStore";
import { getSubAgentState } from "../../stores/subAgentStore";
import {
  computeContextWarning, dismiss, type ContextWarningState,
  DEFAULT_CONTEXT_WARNING_ENABLED, DEFAULT_CONTEXT_WARNING_PERCENT,
} from "../../utils/contextWarning";
import { computeStreamStall } from "../../chat/chatReduce";
import { openSettingsFloat } from "../Toolbar";
import { dataBus } from "../../services/dataBus";
import { StreamStallDecisionBar } from "./StreamStallDecisionBar";
import {
  computeStreamStallDecision, enterWaiting, resetToIdle, shouldAutoWake, type StreamStallDecisionState,
} from "../../utils/streamStallDecision";

function PermissionPrompt({ onAllow, onAllowAlways, onDeny }: {
  onAllow: () => void; onAllowAlways: () => void; onDeny: () => void;
}) {
  const req = getChatState().pendingControlRequest;
  if (!req) return null;

  return (
    <div style={{
      position: "absolute", bottom: 0, left: 16, right: 16,
      backgroundColor: "var(--bg-root)", border: "1px solid var(--accent)", borderRadius: 8,
      boxShadow: "0 4px 16px rgba(0,0,0,0.15)", padding: 12, zIndex: 100,
    }}>
      <div style={{ fontSize: "calc(var(--font-scale, 1) * 13px)", fontFamily: "var(--font-sans)", marginBottom: 8, color: "var(--fg-primary)" }}>
        <strong>{req.tool_name}</strong> {t("permission.wantsToRun")}
        {req.description && <span style={{ color: "var(--fg-secondary)", marginLeft: 4 }}>— {req.description}</span>}
      </div>
      <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
        <button onClick={onDeny} style={permBtn}>{t("permission.deny")}</button>
        <button onClick={onAllowAlways} style={permBtn}>{t("permission.alwaysAllow")}</button>
        <button onClick={onAllow} style={{ ...permBtn, border: "none", backgroundColor: "var(--accent)", color: "var(--fg-inverse)" }}>
          {t("permission.allow")}
        </button>
      </div>
    </div>
  );
}

const permBtn: React.CSSProperties = {
  padding: "4px 12px", border: "1px solid var(--border-medium)", borderRadius: 4,
  backgroundColor: "var(--bg-root)", cursor: "pointer", fontSize: "calc(var(--font-scale, 1) * 12px)", fontFamily: "var(--font-sans)",
};

function fmtK(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(0)}K`;
  return String(n);
}

function getContextColor(usedPct: number): string {
  if (usedPct >= 90) return "var(--semantic-error)";
  if (usedPct >= 70) return "var(--semantic-warning)";
  return "var(--semantic-success)";
}

function goToSettings() {
  // 与命令面板一致：浮动窗口异步创建，SettingsPanel 可能尚未挂载订阅，重试发布几次
  openSettingsFloat();
  const nav = () => dataBus.publish("settings.navigate", { category: "chat", field: "contextWarningPercent" });
  nav();
  setTimeout(nav, 150);
  setTimeout(nav, 350);
}

function ContextWarningPopover({ usedPct, onDismiss }: { usedPct: number; onDismiss: () => void }) {
  return (
    <div style={{
      position: "absolute", bottom: "calc(100% + 6px)", right: 8,
      backgroundColor: "var(--bg-surface)", border: "1px solid var(--semantic-error)", borderRadius: 8,
      boxShadow: "0 4px 16px rgba(0,0,0,0.18)", padding: "8px 10px",
      display: "flex", alignItems: "center", gap: 8, zIndex: 100,
      fontSize: "calc(var(--font-scale, 1) * 12px)", fontFamily: "var(--font-sans)", color: "var(--fg-primary)",
      whiteSpace: "nowrap",
    }}>
      <span style={{ color: "var(--semantic-error)", fontWeight: 600, flexShrink: 0 }}>!</span>
      <span>{t("chat.contextWarningBanner", { pct: Math.round(usedPct) })}</span>
      <button type="button" onClick={goToSettings} style={{
        padding: "2px 8px", border: "none", borderRadius: 4,
        backgroundColor: "var(--accent)", color: "var(--fg-inverse)", cursor: "pointer",
        fontSize: "calc(var(--font-scale, 1) * 11px)", fontFamily: "inherit", flexShrink: 0,
      }}>
        {t("chat.goToSettings")}
      </button>
      <button type="button" onClick={onDismiss} title={t("chat.contextWarningClose")} style={{
        border: "none", background: "none", cursor: "pointer", color: "var(--fg-muted)",
        fontSize: "calc(var(--font-scale, 1) * 13px)", fontFamily: "inherit", lineHeight: 1,
        padding: "2px 4px", flexShrink: 0,
      }}>
        ✕
      </button>
      {/* 指向进度条的三角箭头 */}
      <div style={{
        position: "absolute", top: "100%", right: 26,
        borderLeft: "6px solid transparent", borderRight: "6px solid transparent",
        borderTop: "6px solid var(--semantic-error)",
      }} />
    </div>
  );
}

function ChatStatusBar({ onCompact }: { onCompact?: () => void }) {
  const payload = useEvent<ChatStateChangedPayload>(Events.CHAT_STATE_CHANGED);
  const state = payload?.state ?? getChatState();

  // Flash on any token change (input or output)
  const [tokenFlash, setTokenFlash] = useState(false);
  const prevTokensRef = useRef({ used: 0, output: 0 });
  const tokensKey = `${state.usedTokens}-${state.outputTokens}`;
  useEffect(() => {
    const prev = prevTokensRef.current;
    if ((state.usedTokens !== prev.used || state.outputTokens !== prev.output) && (state.usedTokens > 0 || state.outputTokens > 0)) {
      setTokenFlash(true);
      const t = setTimeout(() => setTokenFlash(false), 400);
      prevTokensRef.current = { used: state.usedTokens, output: state.outputTokens };
      return () => clearTimeout(t);
    }
    prevTokensRef.current = { used: state.usedTokens, output: state.outputTokens };
  }, [tokensKey]);

  let dotColor: string;
  let label: string;

  if (!state.connected) {
    dotColor = "var(--semantic-error)";
    label = t("chat.disconnected");
  } else if (state.streaming) {
    dotColor = "var(--semantic-warning)";
    label = t("chat.streaming");
  } else {
    dotColor = "var(--semantic-success)";
    label = t("chat.ready");
  }

  // 无响应提示：streaming 期间每 3s 检查一次距上次流式活动的时间，超过阈值显示"已 N 秒无响应"。
  // 上游静默停流/中转断连时不再干等，用户立刻知道卡在哪。
  const [stallSeconds, setStallSeconds] = useState(0);
  useEffect(() => {
    if (!state.streaming) {
      setStallSeconds(0);
      return;
    }
    const tick = () => setStallSeconds(computeStreamStall(state.lastStreamEventAt, Date.now(), true));
    tick();
    const iv = setInterval(tick, 3000);
    return () => clearInterval(iv);
  }, [state.streaming, state.lastStreamEventAt]);

  const ctxPct = 100 - (state.contextPercent || 0);
  const ctxColor = getContextColor(ctxPct);
  const ctxActive = state.contextPercent > 0;

  // 上下文告警：已用百分比跨过阈值时弹浮动层（idle/showing/dismissed 状态机）
  // settingsPayload 监听 SETTINGS_CHANGED，保证在设置里关闭开关/调阈值时立即生效
  const settingsPayload = useEvent<{ settings: AppSettings }>(Events.SETTINGS_CHANGED);
  const [warnVisible, setWarnVisible] = useState(false);
  const warnStateRef = useRef<ContextWarningState>({ status: "idle" });
  useEffect(() => {
    if (!ctxActive) {
      warnStateRef.current = { status: "idle" };
      setWarnVisible(false);
      return;
    }
    const s = getSettings();
    const res = computeContextWarning({
      usedPct: ctxPct,
      threshold: s.contextWarningPercent ?? DEFAULT_CONTEXT_WARNING_PERCENT,
      enabled: s.contextWarningEnabled ?? DEFAULT_CONTEXT_WARNING_ENABLED,
      state: warnStateRef.current,
    });
    warnStateRef.current = res.nextState;
    setWarnVisible(res.show);
  }, [ctxPct, ctxActive, settingsPayload]);

  const handleDismissWarn = () => {
    warnStateRef.current = dismiss(warnStateRef.current);
    setWarnVisible(false);
  };

  // 触发时进度条脉冲闪烁
  const barRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (warnVisible && barRef.current) {
      const anim = barRef.current.animate(
        [
          { backgroundColor: "#ff6b6b", boxShadow: "0 0 2px #ff6b6b" },
          { backgroundColor: "#e23b3b", boxShadow: "0 0 8px #e23b3b" },
        ],
        { duration: 400, iterations: 3, direction: "alternate" },
      );
      return () => anim.cancel();
    }
  }, [warnVisible]);

  return (
    <div style={{
      display: "flex", alignItems: "center", height: 22, padding: "0 10px",
      borderTop: "1px solid var(--border-medium)", backgroundColor: "var(--bg-hover)",
      fontSize: "calc(var(--font-scale, 1) * 11px)", fontFamily: "var(--font-sans)", color: "var(--fg-secondary)", gap: 10, flexShrink: 0,
      position: "relative",
    }}>
      {/* Connection dot + label */}
      <span style={{
        width: 8, height: 8, borderRadius: "50%",
        backgroundColor: dotColor, display: "inline-block", flexShrink: 0,
      }} />
      <span style={{ flexShrink: 0 }}>{label}</span>

      {/* 无响应提示：streaming 超过阈值无流式活动 → 显示已卡顿秒数 */}
      {state.streaming && stallSeconds > 0 && (
        <span style={{
          color: "var(--semantic-warning)", flexShrink: 0,
          fontVariantNumeric: "tabular-nums", fontWeight: 600,
        }}
          title={t("chat.streamStalledHint")}>
          {"\u23F3"} {t("chat.streamStalled", { secs: String(stallSeconds) })}
        </span>
      )}

      {/* Separator */}
      <div style={{ flex: 1 }} />

      {/* Token count + Context bar — main display is the CURRENT context window fill
          (usedTokens/size). Session-cumulative totals are in the tooltip only, so
          the two different bases (window vs. session) never get visually mixed. */}
      {state.contextPercent > 0 && (
        <>
          <span style={{
            fontSize: 10, color: tokenFlash ? "var(--accent)" : "var(--fg-muted)", flexShrink: 0,
            fontWeight: tokenFlash ? 600 : 400,
            transition: "color 0.3s, font-weight 0.3s",
            fontVariantNumeric: "tabular-nums",
          }}
            title={t("chat.contextWindowTooltip", {
              used: state.usedTokens.toLocaleString(),
              size: state.contextWindowSize.toLocaleString(),
              input: state.inputTokens.toLocaleString(),
              output: state.outputTokens.toLocaleString(),
              cacheRead: state.cacheReadTokens.toLocaleString(),
              cacheCreate: state.cacheCreationTokens.toLocaleString(),
            })}>
            <span style={{ color: "var(--fg-muted)" }}>ctx</span>{" "}
            <span style={{ color: tokenFlash ? "var(--accent)" : "var(--fg-secondary)" }}>{fmtK(state.usedTokens)}</span>
            <span style={{ color: "var(--fg-muted)" }}>/{fmtK(state.contextWindowSize)}</span>
          </span>

          <span style={{ color: "var(--border-medium)", fontSize: 10 }}>|</span>

          <div title={t("chat.contextRemaining", { pct: state.contextPercent })} style={{
            display: "flex", alignItems: "center", gap: 4,
          }}>
            <div style={{
              width: 50, height: 4, borderRadius: 2,
              backgroundColor: "var(--border-light)", overflow: "hidden", flexShrink: 0,
            }}>
              <div ref={barRef} style={{
                width: `${ctxPct}%`, height: "100%",
                backgroundColor: ctxColor, borderRadius: 2,
                transition: "width 0.3s ease",
              }} />
            </div>
            <span style={{
              fontSize: 10, flexShrink: 0, minWidth: 26,
              color: warnVisible ? "var(--semantic-error)" : "var(--fg-muted)",
              fontWeight: warnVisible ? 700 : 400,
              transition: "color 0.3s, font-weight 0.3s",
            }}>
              {state.contextPercent}%
            </span>
          </div>

          {/* Compact context button */}
          {onCompact && (
            <button
              type="button"
              onClick={onCompact}
              title={t("chat.compactConversation")}
              style={{
                display: "flex", alignItems: "center", gap: 2,
                padding: "1px 5px", border: "1px solid var(--border-medium)", borderRadius: 3,
                backgroundColor: "var(--bg-surface)", cursor: "pointer",
                fontSize: 10, fontFamily: "var(--font-sans)", color: "var(--fg-secondary)",
                lineHeight: "16px", flexShrink: 0,
              }}
            >
              <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
                <path d="M2 3h12v1H2V3zm0 3h12v1H2V6zm0 3h12v1H2V9zm0 3h10v1H2v-1z"/>
              </svg>
              {t("chat.compactConversation")}
            </button>
          )}
        </>
      )}
      {warnVisible && <ContextWarningPopover usedPct={ctxPct} onDismiss={handleDismissWarn} />}
    </div>
  );
}

export function ChatInputPanel() {
  const t = useT();
  const payload = useEvent<ChatStateChangedPayload>(Events.CHAT_STATE_CHANGED);
  const state = payload?.state ?? getChatState();
  const queuePos = useQueuePosition();
  const queueCollapse = useMsgQueueCollapse();
  const { port } = useBackend();
  const { sendMessage, respondToPermission, interrupt, compact, wakeStream } = useChatBridge(port);
  const askFloatRef = useRef<string | null>(null);

  // 流静默决策期：模型流静默超过阈值时弹「是否中断？」，让用户裁量而非硬杀。
  const [showStallDecision, setShowStallDecision] = useState(false);
  const stallDecisionRef = useRef<StreamStallDecisionState>({ status: "idle", lastSeenActivity: null });
  const interruptRef = useRef(interrupt);
  interruptRef.current = interrupt; // 每渲染更新，避免 interval 闭包捕旧值
  const wakeRef = useRef(wakeStream);
  wakeRef.current = wakeStream;
  // 上次自动唤醒时间：自动唤醒后冷却期内再次卡死只纯中断，防"唤醒→又卡→又唤醒"死循环
  const lastAutoWakeRef = useRef<number | null>(null);

  useEffect(() => {
    // 3s 轮询（与「已 N 秒无响应」提示一致）：靠时间推进触发状态迁移。
    const tick = () => {
      const st = getChatState();
      // 等用户回答(AskUserQuestion/权限)、压缩会话中，或有子代理在跑时，agent 回合未结束、
      // 流也无事件，但这 ≠ 流卡死（一个在等用户、一个在压缩处理、一个在等子代理完成）。
      // 静默计时不该计入，抑制决策期——否则等子代理完成会被误判"流卡死"。
      const hasRunningSubAgent = getSubAgentState().agents.some((a) => a.status === "running");
      if (st.pendingControlRequest || st.compacting || hasRunningSubAgent) {
        stallDecisionRef.current = resetToIdle();
        setShowStallDecision(false);
        return;
      }
      const res = computeStreamStallDecision({
        streaming: st.streaming,
        lastStreamEventAt: st.lastStreamEventAt,
        now: Date.now(),
        state: stallDecisionRef.current,
      });
      stallDecisionRef.current = res.nextState;
      setShowStallDecision(res.show);
      if (res.autoInterrupt) {
        // 决策期无响应超时：中断后视冷却决定是否"唤醒"(发醒词接力)。
        // 冷却内只纯中断(停止自动恢复)，冷却过了才自动唤醒。最后一次都回 idle 防重复。
        stallDecisionRef.current = resetToIdle();
        if (shouldAutoWake(lastAutoWakeRef.current, Date.now())) {
          lastAutoWakeRef.current = Date.now();
          wakeRef.current(); // 中断 + 发醒词，让 AI 接力继续
        } else {
          interruptRef.current(); // 冷却中：纯中断，不唤醒
        }
      }
    };
    tick();
    const iv = setInterval(tick, 3000);
    return () => clearInterval(iv);
  }, []);

  // Open/close floating window for AskUserQuestion
  useEffect(() => {
    const req = state.pendingControlRequest;
    if (req?.tool_name === "AskUserQuestion") {
      if (askFloatRef.current) {
        // Already open — bring to front
        const exists = getFloatingPanels().find((fp) => fp.id === askFloatRef.current);
        if (exists) { bringFloatingToFront(askFloatRef.current); return; }
        askFloatRef.current = null;
      }
      const x = Math.max(20, window.innerWidth - 480);
      const y = Math.max(60, (window.innerHeight - 420) / 2);
      const id = addFloatingPanel(
        {
          type: "group",
          id: `ask-question-float-${crypto.randomUUID()}`,
          tabs: [{ id: "tab-ask-question", panelId: "ask-question", title: t("chat.questionPanelTitle") }],
          activeTabId: "tab-ask-question",
          tabStyle: "tabs",
        },
        x, y, 440, 420,
      );
      askFloatRef.current = id;
      setAskQuestionCallbacks(id,
        (answers, annotations) => {
          const input = { ...req.tool_input, answers, annotations };
          respondToPermission(true, false, input);
        },
        () => respondToPermission(false),
      );
    } else if (askFloatRef.current && !req) {
      // Request was cleared externally — close floating window
      removeFloatingPanel(askFloatRef.current);
      clearAskQuestionCallbacks();
      askFloatRef.current = null;
    }
  }, [state.pendingControlRequest?.request_id]);

  // Cleanup on unmount
  useEffect(() => () => {
    if (askFloatRef.current) {
      removeFloatingPanel(askFloatRef.current);
      clearAskQuestionCallbacks();
    }
  }, []);

  // Slash command routing: intercept /cmd before sending to backend
  const handleRoutedSend = useCallback(async (content: string) => {
    const trimmed = content.trim();
    // Check if it's a slash command
    if (trimmed.startsWith("/")) {
      const spaceIdx = trimmed.indexOf(" ");
      const cmdName = spaceIdx > 0 ? trimmed.slice(1, spaceIdx) : trimmed.slice(1);
      const decision = routeCommand(cmdName);

      switch (decision.category) {
        case "B": {
          // Open/map to existing panel
          if (decision.panelId) {
            const tree = (await import("../../stores/layoutStore")).getTree();
            const found = findTabByPanelId(tree, decision.panelId);
            if (found) {
              ensureGroupVisible(found.groupId);
              setActiveTab(found.groupId, found.tabId);
            } else {
              addStatusMessage(t("chat.panelNotOpen", { panelId: decision.panelId }), "info");
            }
          }
          return; // Don't send to backend
        }
        case "C": {
          // Spawn system terminal with Claude. macOS 用系统 Terminal；Windows 优先 git-bash 兜底 cmd。
          const settings = getSettings();
          const workDir = settings.workDir || "";
          const isMac = /mac/i.test(navigator.platform || "");
          try {
            const { invoke } = await import("@tauri-apps/api/core");
            if (isMac) {
              await invoke("open_system_terminal", { terminalType: "terminal", workDir, claudeLaunch: true });
            } else {
              // Windows: 优先 git-bash（少引号/命令问题），缺失时兜底 cmd 并提示
              try {
                await invoke("open_system_terminal", { terminalType: "git-bash", workDir, claudeLaunch: true });
              } catch {
                await invoke("open_system_terminal", { terminalType: "cmd", workDir, claudeLaunch: true });
                addStatusMessage(t("chat.terminalGitBashFallback"), "info");
              }
            }
            addStatusMessage(t("chat.terminalOpened"), "success");
            setTimeout(() => { requestPluginRefresh(); }, 15000);
          } catch {
            addStatusMessage(t("chat.terminalFailed"), "error");
          }
          return;
        }
        case "D": {
          addStatusMessage(t("chat.commandUnavailable"), "error");
          return; // Don't send — show error
        }
        // A: fall through to normal send
      }
    }
    sendMessage(content);
  }, [sendMessage]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, position: "relative" }}>
      <TasksPanel />
      {state.pendingControlRequest && state.pendingControlRequest.tool_name !== "AskUserQuestion" && (
        <PermissionPrompt
          onAllow={() => respondToPermission(true)}
          onAllowAlways={() => respondToPermission(true, true)}
          onDeny={() => respondToPermission(false)}
        />
      )}
      {showStallDecision && (
        <StreamStallDecisionBar
          onWait={() => {
            // 用户接管决定权：抑制再弹，直到流恢复活动（lastStreamEventAt 变化）才解除
            stallDecisionRef.current = enterWaiting({
              streaming: getChatState().streaming,
              lastStreamEventAt: getChatState().lastStreamEventAt,
              now: Date.now(),
              state: stallDecisionRef.current,
            });
            setShowStallDecision(false);
          }}
          onWake={() => {
            stallDecisionRef.current = resetToIdle();
            setShowStallDecision(false);
            wakeStream();
          }}
          onInterrupt={() => {
            stallDecisionRef.current = resetToIdle();
            setShowStallDecision(false);
            interrupt();
          }}
        />
      )}
      {/* 队列作为输入框容器的插槽(top/right), 与输入框共享外框(无双重边框)
          右侧收起态: 不占右侧空间, 胶囊放到 footer 行(发送按钮旁) */}
      <InputArea onSend={handleRoutedSend} onInterrupt={interrupt} streaming={state.streaming}
        topSlot={queuePos === "top" ? <MsgQueuePanel pos="top" bare display={queueCollapse.display} onToggle={queueCollapse.toggle} /> : undefined}
        rightSlot={queuePos === "right" && queueCollapse.display === "expanded"
          ? <MsgQueuePanel pos="right" bare display="expanded" onToggle={queueCollapse.toggle} /> : undefined}
        footerSlot={queuePos === "right" && queueCollapse.display !== "expanded"
          ? <MsgQueueFooterCapsule onToggle={queueCollapse.toggle} /> : undefined} />
      <ChatStatusBar onCompact={compact} />
    </div>
  );
}
