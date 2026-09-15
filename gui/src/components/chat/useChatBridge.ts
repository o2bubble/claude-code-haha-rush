// ── useChatBridge — thin facade over the ChatSession singleton ──
// Keeps the exact hook return shape and standalone export names so every
// caller (ChatInputPanel, ChatMessagesPanel, SessionPanel, TasksPanel,
// SubAgentPanel, SkillsPanel, referenceActions, crossWindowBusHub) is unchanged.

import { useEffect, useRef } from "react";
import { chatSession } from "../../chat/chatSession";
import { getChatState } from "../../stores/chatStore";
import { setTranscriptLoading } from "../../stores/subAgentStore";

export function useChatBridge(port: number | null) {
  useEffect(() => {
    chatSession.registerCommands();
  }, []);

  const lastPortRef = useRef(0);
  useEffect(() => {
    if (!port) return;
    if (lastPortRef.current === port && getChatState().connected) return;
    lastPortRef.current = port;
    chatSession.connect(port);
  }, [port]);

  const prevConnected = useRef(false);
  useEffect(() => {
    const state = getChatState();
    if (state.connected && !prevConnected.current) {
      prevConnected.current = true;
      setTimeout(() => chatSession.send("list_sessions"), 500);
    }
    if (!state.connected) {
      prevConnected.current = false;
    }
  }, [getChatState().connected]);

  return {
    sendMessage: chatSession.sendMessage,
    respondToPermission: chatSession.respondToPermission,
    interrupt: chatSession.interrupt,
    compact: chatSession.compact,
    wakeStream: chatSession.wakeStream,
    listSessions: chatSession.listSessions,
    loadSession: chatSession.loadSession,
    newSession: chatSession.newSession,
    deleteSession: chatSession.deleteSession,
  };
}

export function send(type: string, payload?: any) {
  return chatSession.send(type, payload);
}
export function requestPluginRefresh() {
  send("plugin_refresh");
}
export function requestSessionList() {
  send("list_sessions");
}
export function switchSession(id: string) {
  send("resume_session", { session_id: id });
}
/** 启动意图: 标记已有明确目标会话(抑制"自动加载最近会话") */
export function setIntentTargeted(v: boolean) {
  chatSession.setIntentTargeted(v);
}
/** 启动意图: 一步打开目标会话(不先切最近), 置 autoLoaded 防回跳 */
export function launchIntentSession(id: string) {
  chatSession.launchIntentSession(id);
}
export function createSession() {
  chatSession.resetSession();
  send("new_session");
  setTimeout(() => send("list_sessions"), 2000);
}
export function removeSession(id: string) {
  send("delete_session", { session_id: id });
  setTimeout(() => send("list_sessions"), 1000);
}
export function renameSession(id: string, title: string) {
  send("rename_session", { session_id: id, title });
}
/**
 * 分叉会话：以 id 为**源**复制出一个新会话。
 *
 * 不切换当前会话 —— 新会话只是出现在列表里，何时切过去由用户决定
 * （后端回 `session_forked` 而非 `session_created`，后者在 GUI 侧会切会话）。
 * 无需在此再拉列表：后端处理完会主动推 `session_list`。
 */
export function forkSession(id: string) {
  send("fork_session", { session_id: id });
}
export function killTask(taskId: string) {
  send("kill_task", { task_id: taskId });
}
export function loadAgentTranscript(taskId: string) {
  setTranscriptLoading(taskId);
  send("load_agent_transcript", { task_id: taskId });
}
export function requestTaskList() {
  send("list_tasks");
}
