import React, { memo, useState, useEffect, useCallback, useRef } from "react";
import { ListChecks, Folder, FolderInput, Plus, Pencil, Trash2, ChevronRight, ChevronDown, ArrowUpRight, MoreHorizontal } from "lucide-react";
import type { Session } from "../../stores/chatStore";
import { getChatState } from "../../stores/chatStore";
import { isBackendBusy } from "../../chat/chatReduce";
import { shouldConfirmSwitch } from "./sessionSwitchGuard";
import { getSettings, updateSettings, saveSettings } from "../../stores/settingsStore";
import { partitionSessions } from "./sessionFavorites";
import {
  createFolder, renameFolder, deleteFolder, moveFolder, assignSession, unassignSession, moveSessions,
  buildFolderTree, partitionSessions as partitionByFolder,
  pruneOrphanAssignments, isSessionListComplete,
  type SessionFolderTree, type FolderNode, type SessionFolder,
} from "./sessionFolders";
import {
  requestSessionList,
  switchSession,
  createSession,
  removeSession,
  renameSession,
  forkSession,
} from "./useChatBridge";
import { showCtxMenu, type ContextMenuItem } from "../ContextMenu";
import { t } from "../../i18n";
import { addStatusMessage } from "../../stores/statusMsgStore";
import { commandRegistry } from "../../services/windowBus";
import { Commands } from "../../services/commands";
import { useEvent } from "../../services/useService";
import { Events, type ChatStateChangedPayload, type SettingsChangedPayload } from "../../services/events";
import { subscribeSessionStatus, getSessionOpenElsewhere } from "../../stores/sessionStatusStore";

// ── Confirm Dialog (single or batch) ──

function ConfirmDialog({ count, title, onConfirm, onCancel }: {
  count: number; title?: string; onConfirm: () => void; onCancel: () => void;
}) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onCancel(); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onCancel]);

  return (
    <div
      onClick={onCancel}
      style={{
        position: "fixed", inset: 0, zIndex: 9999,
        display: "flex", alignItems: "center", justifyContent: "center",
        backgroundColor: "rgba(0,0,0,0.3)",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          backgroundColor: "var(--bg-root)", borderRadius: 8,
          boxShadow: "0 8px 32px rgba(0,0,0,0.2)",
          padding: 20, minWidth: 280, maxWidth: 400,
          fontFamily: "var(--font-sans)",
        }}
      >
        <div style={{ fontSize: "calc(var(--font-scale, 1) * 14px)", fontWeight: 600, color: "var(--fg-primary)", marginBottom: 10 }}>
          {count > 1 ? t("sessions.deleteTitleBatch", { count }) : t("sessions.deleteTitle")}
        </div>
        <div style={{ fontSize: "calc(var(--font-scale, 1) * 13px)", color: "var(--fg-secondary)", marginBottom: 18, lineHeight: 1.4 }}>
          {count > 1
            ? t("sessions.deleteMessageBatch", { count })
            : t("sessions.deleteMessage", { title: title ?? "" })}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button type="button" onClick={onCancel} style={dialogBtn("var(--bg-root)", "var(--border-medium)", "var(--fg-primary)")}>
            {t("sessions.cancel")}
          </button>
          <button type="button" onClick={onConfirm} style={dialogBtn("var(--semantic-error)", "none", "var(--fg-inverse)")}>
            {t("sessions.delete")}
          </button>
        </div>
      </div>
    </div>
  );
}

function dialogBtn(bg: string, border: string, color: string): React.CSSProperties {
  return {
    padding: "6px 16px", border: `1px solid ${border}`, borderRadius: 4,
    backgroundColor: bg, cursor: "pointer", fontSize: "calc(var(--font-scale, 1) * 12px)", color, fontWeight: bg === "var(--semantic-error)" ? 600 : 400,
  };
}

// ── SessionPanel ──

function SessionPanelImpl() {
  const payload = useEvent<ChatStateChangedPayload>(Events.CHAT_STATE_CHANGED);
  const chatState = payload?.state ?? getChatState();
  // 跨 GUI 会话状态索引变化 → 重渲染列表（标记"↑另一窗口打开"+工作/空闲圆点）
  const [, setStatusRev] = useState(0);
  useEffect(() => subscribeSessionStatus(() => setStatusRev((r) => r + 1)), []);
  const sessions = chatState.sessions;
  const connected = chatState.connected;
  // Re-render when settings change — favorites live in settings, and a
  // workspace (re)bind reloads them from the bound workspace's local file.
  useEvent<SettingsChangedPayload>(Events.SETTINGS_CHANGED);
  const [deleteTarget, setDeleteTarget] = useState<Session | null>(null);
  const [confirmOpenElsewhere, setConfirmOpenElsewhere] = useState<Session | null>(null);
  const [confirmBusySwitch, setConfirmBusySwitch] = useState<Session | null>(null);
  const [batchDeleteCount, setBatchDeleteCount] = useState(0);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [, setTick] = useState(0);
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  // ── Favorites (workspace-scoped, persisted to <workdir>/.claude/settings.local.json) ──
  const favIds = getSettings().favoriteSessionIds ?? [];
  const favSet = new Set(favIds);
  const { favSessions, staleFavIds, regularSessions } = partitionSessions(sessions, favIds);
  // Only label favorites as stale once the session list has actually arrived —
  // before the backend is ready the list is empty and every favorite would
  // wrongly show as missing.
  const shownStaleFavIds = chatState.sessionsLoaded ? staleFavIds : [];
  const showFavs = favSessions.length > 0 || shownStaleFavIds.length > 0;

  const toggleFavorite = useCallback((id: string) => {
    const s = getSettings();
    const favs = new Set(s.favoriteSessionIds ?? []);
    if (favs.has(id)) favs.delete(id); else favs.add(id);
    const list = [...favs];
    updateSettings({ favoriteSessionIds: list });
    // 保存经 saveSettings → 内部 notify_settings_changed 广播给其他实例跨 GUI 同步。
    saveSettings({ favoriteSessionIds: list }, "workspace");
    setTick((t) => t + 1);
  }, []);

  // ── 启动意图：在新窗口打开会话（发起方）──
  // Publish 意图到 server + spawn `--intent <id>` 新 GUI，然后轮询直到 done。
  const openInNewWindow = useCallback(async (sessionId: string) => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const ws = getSettings().workDir ?? "";
      const intentId = crypto.randomUUID();
      await invoke("publish_startup_intent", {
        intentId,
        payload: { workspace: ws, kind: "open_session", session_id: sessionId },
      });
      await invoke("spawn_intent_gui", { intentId });
      addStatusMessage(t("sessions.openedInNewWindow"), "info");
      // 轮询：新实例 claim→执行→ack 后 status=done/expired。
      for (let i = 0; i < 60; i++) {
        try {
          const st = await invoke<any>("query_intent_status", { intentId });
          if (st?.status === "done") {
            addStatusMessage(t("sessions.targetOpened"), "info");
            return;
          }
          if (st?.status === "expired") return; // 新实例未能兑现
        } catch { return; } // 意图已被 GC → 停止轮询
        await new Promise((r) => setTimeout(r, 500));
      }
    } catch (e) {
      addStatusMessage(t("sessions.openFailed"), "warn");
    }
  }, []);

  // ── 会话文件夹（设置开关开启时生效；工作区作用域，同收藏）──
  const foldersEnabled = getSettings().sessionFolders ?? false;
  const folderTree: SessionFolderTree = getSettings().sessionFolderTree ?? { folders: [], assignments: {} };
  const folderNodes = buildFolderTree(folderTree);
  const folderPartition = partitionByFolder(folderTree, sessions);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [newFolderParent, setNewFolderParent] = useState<string | null | undefined>(undefined);
  const [newFolderName, setNewFolderName] = useState("");
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
  const [renameFolderName, setRenameFolderName] = useState("");
  const [deleteFolderTarget, setDeleteFolderTarget] = useState<SessionFolder | null>(null);
  const [movePickerFor, setMovePickerFor] = useState<string[] | null>(null);
  const [reparentFolderFor, setReparentFolderFor] = useState<string | null>(null);
  const [dragSessionId, setDragSessionId] = useState<string | null>(null);

  // 会话被删除后清理其在 assignments 里的孤儿归属（显示层已过滤, 这里防数据膨胀）。
  // 双保险 + 时序保护：
  //   - connected: ws 未就绪时 sessions 为空是「列表还没到」, 不是「会话被删光了」,
  //     绝不能据此清空所有 assignments(否则重启后文件夹归属全丢)。
  //   - 非空保护: 删除动作本身已主动清理(handleSingle/BatchDelete), 这里只兜底;
  //     空列表跳过, 因为「全部会话都删光」应由删除动作逐一清理。
  //   - 防抖: 列表分帧到达时避免首帧(部分列表)误判后续会话为孤儿。
  useEffect(() => {
    if (!chatState.connected || !chatState.sessionsLoaded) return;
    if (sessions.length === 0) return;
    // 列表完整性保护：total > 返回数（截断/分页）时「不在列表」≠「会话被删」，
    // 绝不能据此清孤儿归属——否则真实存在的会话被误删归属，下次回列表显示未分类/找不到。
    if (!isSessionListComplete(sessions.length, chatState.sessionTotal)) return;
    const timer = setTimeout(() => {
      const live = new Set(sessions.map((s) => s.id));
      const assigns = folderTree.assignments;
      const next: SessionFolderTree = {
        ...folderTree,
        assignments: pruneOrphanAssignments(assigns, live),
      };
      if (next.assignments !== assigns) saveFolderTree(next);
    }, 1500);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatState.connected, chatState.sessionsLoaded, chatState.sessionTotal, sessions]);

  const saveFolderTree = useCallback((next: SessionFolderTree) => {
    updateSettings({ sessionFolderTree: next });
    saveSettings({ sessionFolderTree: next }, "workspace");
    setTick((t) => t + 1);
  }, []);

  const toggleFolderExpand = (id: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  // 防 Enter(onKeyDown) + 卸载时 onBlur 双触发创建重复文件夹
  const newFolderConfirmingRef = useRef(false);
  const confirmNewFolder = () => {
    if (newFolderConfirmingRef.current) return;
    const name = newFolderName.trim();
    if (!name) { setNewFolderParent(undefined); return; }
    newFolderConfirmingRef.current = true;
    saveFolderTree(createFolder(folderTree, crypto.randomUUID(), name, newFolderParent ?? undefined));
    setNewFolderParent(undefined);
    setTimeout(() => { newFolderConfirmingRef.current = false; }, 0);
    // fallthrough continues below (setNewFolderName reset)
    setNewFolderName("");
  };

  const confirmRenameFolder = () => {
    const name = renameFolderName.trim();
    if (renamingFolderId && name) saveFolderTree(renameFolder(folderTree, renamingFolderId, name));
    setRenamingFolderId(null);
  };

  const confirmDeleteFolder = () => {
    if (deleteFolderTarget) saveFolderTree(deleteFolder(folderTree, deleteFolderTarget.id));
    setDeleteFolderTarget(null);
  };

  const renderFolderNode = (node: FolderNode, depth: number): React.ReactNode => {
    const fid = node.folder.id;
    const expanded = expandedFolders.has(fid);
    const folderSessions = folderPartition.byFolder[fid] ?? [];
    const indent = 8 + depth * 14;
    return (
      <div key={fid}>
        <div
          style={{
            display: "flex", alignItems: "center", gap: 4,
            padding: "5px 6px 5px " + indent + "px", cursor: "pointer",
            userSelect: "none", color: "var(--fg-primary)", fontFamily: "var(--font-sans)",
          }}
          onClick={() => toggleFolderExpand(fid)}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = "var(--bg-hover)"; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = "transparent"; }}
          onDragOver={(e) => { e.preventDefault(); (e.currentTarget as HTMLElement).style.boxShadow = "inset 0 0 0 2px var(--accent)"; }}
          onDragLeave={(e) => { (e.currentTarget as HTMLElement).style.boxShadow = "none"; }}
          onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
            (e.currentTarget as HTMLElement).style.boxShadow = "none";
            if (dragSessionId) {
              saveFolderTree(assignSession(folderTree, dragSessionId, node.folder.id));
              setDragSessionId(null);
            }
          }}
        >
          <ChevronRight size={12} style={{ flexShrink: 0, color: "var(--fg-muted)", transform: expanded ? "rotate(90deg)" : "none", transition: "transform 0.12s" }} />
          <Folder size={13} style={{ flexShrink: 0, color: "var(--accent)", opacity: 0.85 }} />
          {renamingFolderId === fid ? (
            <input
              type="text" autoFocus value={renameFolderName}
              onChange={(e) => setRenameFolderName(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); confirmRenameFolder(); } if (e.key === "Escape") setRenamingFolderId(null); }}
              onBlur={confirmRenameFolder}
              style={{ flex: 1, minWidth: 0, border: "1px solid var(--accent)", borderRadius: 3, padding: "1px 5px", fontSize: "calc(var(--font-scale, 1) * 12px)", background: "var(--bg-root)", color: "var(--fg-primary)", outline: "none" }}
            />
          ) : (
            <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 600, fontSize: "calc(var(--font-scale, 1) * 12px)", color: "var(--fg-primary)" }}>{node.folder.name}</span>
          )}
          <span style={{ fontSize: "calc(var(--font-scale, 1) * 10px)", color: "var(--fg-muted)", flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>{folderSessions.length}</span>
          <span style={{ display: "flex", gap: 1, flexShrink: 0, marginLeft: 2 }}>
            <button type="button" title={t("sessions.newSubFolder")} aria-label={t("sessions.newSubFolder")} onClick={(e) => { e.stopPropagation(); setNewFolderParent(fid); setNewFolderName(""); }} style={{ ...iconBtnStyle, display: "flex", alignItems: "center", padding: "2px 4px", opacity: 0.6 }}><Plus size={12} /></button>
            <button type="button" title={t("sessions.moveFolder")} aria-label={t("sessions.moveFolder")} onClick={(e) => { e.stopPropagation(); setReparentFolderFor(fid); }} style={{ ...iconBtnStyle, display: "flex", alignItems: "center", padding: "2px 4px", opacity: 0.6 }}><FolderInput size={12} /></button>
            <button type="button" title={t("sessions.rename")} aria-label={t("sessions.rename")} onClick={(e) => { e.stopPropagation(); setRenamingFolderId(fid); setRenameFolderName(node.folder.name); }} style={{ ...iconBtnStyle, display: "flex", alignItems: "center", padding: "2px 4px", opacity: 0.6 }}><Pencil size={12} /></button>
            <button type="button" title={t("sessions.delete")} aria-label={t("sessions.delete")} onClick={(e) => { e.stopPropagation(); setDeleteFolderTarget(node.folder); }} style={{ ...iconBtnStyle, display: "flex", alignItems: "center", padding: "2px 4px", opacity: 0.6, color: "var(--fg-secondary)" }}><Trash2 size={12} /></button>
          </span>
        </div>
        {newFolderParent === fid && (
          <div style={{ padding: "2px 6px 2px " + (indent + 22) + "px" }}>
            <input
              type="text" autoFocus value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); confirmNewFolder(); } if (e.key === "Escape") setNewFolderParent(undefined); }}
              onBlur={confirmNewFolder}
              placeholder={t("sessions.folderNamePlaceholder")}
              style={{ width: "100%", border: "1px solid var(--accent)", borderRadius: 3, padding: "1px 5px", fontSize: "calc(var(--font-scale, 1) * 12px)", background: "var(--bg-root)", color: "var(--fg-primary)", outline: "none" }}
            />
          </div>
        )}
        {expanded && (
          <>
            {folderSessions.map((s) => renderSessionRow(s))}
            {node.children.map((c) => renderFolderNode(c, depth + 1))}
          </>
        )}
      </div>
    );
  };

  /**
   * 单个会话行的操作菜单（⋯ 按钮与右键共用同一份，保证两处一致）。
   *
   * 行内只保留最高频的「切换（点整行）」与「收藏（★，需看到状态）」；
   * 其余都收进这里，避免一行堆五个按钮。
   *
   * 顺序按 高频/安全 → 低频/危险，删除放最后且标红。
   *
   * 刻意**不用 useCallback**：它引用的 `startRename` 定义在本文件更靠后的位置，
   * 而 useCallback 的依赖数组在渲染时求值 → 会触发 TDZ
   * （Cannot access 'startRename' before initialization）。
   * 这个函数只在用户点击时调用，重建开销可忽略。
   */
  const buildSessionMenu = (s: Session): ContextMenuItem[] => {
    const items: ContextMenuItem[] = [
      {
        label: t("sessions.copyName"),
        action: () => {
          navigator.clipboard.writeText(s.title).catch(() => {});
          addStatusMessage(t("sessions.copyNameDone"), "info");
        },
      },
      {
        // 分叉 = 以该会话为源复制一份新会话，**不切换**当前会话（新会话出现在列表里）。
        // 若源会话正在流式写入，复制到的是「此刻已落盘的内容」—— 与复制文件语义一致。
        label: t("sessions.fork"),
        action: () => {
          forkSession(s.id);
          addStatusMessage(t("sessions.forkDone"), "info");
        },
      },
      { separator: true },
      { label: t("sessions.rename"), action: () => startRename(s) },
    ];
    if (foldersEnabled) {
      items.push({
        label: t("sessions.moveToFolder"),
        action: () => setMovePickerFor([s.id]),
      });
    }
    items.push(
      {
        label: t("sessions.openInNewWindow"),
        action: () => void openInNewWindow(s.id),
      },
      { separator: true },
      {
        label: t("sessions.delete"),
        action: () => setDeleteTarget(s),
        danger: true,
      },
    );
    return items;
  };

  const renderSessionRow = (s: Session) => {
    // 当前会话高亮：优先后端 is_active，兜底前端 sessionId（后端不总是下发激活标记）
    const isCurrent = s.isActive || s.id === chatState.sessionId;
    const openElsewhere = getSessionOpenElsewhere(s.id, getSettings().workDir ?? "");
    const elsewhereWorking = openElsewhere.some((e) => e.state === "working");
    return (
    <div
      key={s.id}
      onClick={() => {
        if (selectMode) {
          toggleSelect(s.id);
        } else if (openElsewhere.length > 0 && !isCurrent) {
          // 已在另一窗口打开（且不是当前会话）→ 软警告，用户确认才切换（best-effort）
          setConfirmOpenElsewhere(s);
        } else if (shouldConfirmSwitch({ backendBusy: isBackendBusy(chatState) }, chatState.sessionId, s.id)) {
          // 后端仍在跑（思考/工具中）→ 切换会 interruptCurrentTurn() 打断本回合，
          // 已消耗的 token 不可恢复。先确认，避免误点打断。
          setConfirmBusySwitch(s);
        } else {
          switchSession(s.id);
          commandRegistry.execute(Commands.CHAT_FOCUS_INPUT);
        }
      }}
      style={{
        display: "flex", alignItems: "center", gap: 6,
        padding: "6px 10px 6px 10px", cursor: "pointer",
        paddingRight: 10,
        borderBottom: "1px solid var(--border-light)",
        backgroundColor: isCurrent && !selectMode ? "var(--bg-active)" : "transparent",
        color: isCurrent && !selectMode ? "var(--accent)" : "var(--fg-primary)",
        userSelect: "none",
      }}
      onMouseEnter={(e) => {
        setHoveredId(s.id);
        if (!isCurrent || selectMode)
          (e.currentTarget as HTMLElement).style.backgroundColor = "var(--bg-hover)";
      }}
      onMouseLeave={(e) => {
        setHoveredId(null);
        if (!isCurrent || selectMode)
          (e.currentTarget as HTMLElement).style.backgroundColor = "transparent";
      }}
      draggable={foldersEnabled && !selectMode}
      onDragStart={(e) => { e.stopPropagation(); setDragSessionId(s.id); }}
      onDragEnd={() => setDragSessionId(null)}
      // 右键与 ⋯ 按钮共用同一份菜单，两处入口行为一致。
      // 多选模式下不弹（保持框选交互），正在改名时也不弹（避免打断输入）。
      onContextMenu={(e) => {
        if (selectMode || editingId === s.id) return;
        e.preventDefault();
        e.stopPropagation();
        showCtxMenu(e.clientX, e.clientY, buildSessionMenu(s));
      }}
    >
      {/* Checkbox in select mode */}
      {selectMode && (
        <input
          type="checkbox"
          checked={selectedIds.has(s.id)}
          onChange={() => toggleSelect(s.id)}
          onClick={(e) => e.stopPropagation()}
          style={{ margin: 0, cursor: "pointer" }}
        />
      )}
      {/* 正在切换到这一项 —— 与消息区的遮罩不同，这里**不延迟**：
          它是"我点了"的直接反馈，晚出现反而像点不动。 */}
      {chatState.switchingTo === s.id && (
        <span
          title={t("chat.switchingSession")}
          style={{
            width: 10, height: 10, flexShrink: 0,
            border: "1.5px solid var(--accent)", borderTopColor: "transparent",
            borderRadius: "50%", animation: "spin 1s linear infinite",
            display: "inline-block",
          }}
        />
      )}
      {/* 跨 GUI 标记：其他实例打开的会话标"↗另一窗口打开"+状态圆点；当前会话只显自己的状态圆点 */}
      {(isCurrent || openElsewhere.length > 0) && (
        <span
          className="session-status-marker"
          title={isCurrent ? (chatState.streaming ? t("sessions.statusWorking") : t("sessions.statusIdle")) : t("sessions.openElsewhere")}
          style={{ display: "inline-flex", alignItems: "center", gap: 4, flexShrink: 0, marginRight: 1 }}
        >
          <span
            className="session-status-dot"
            data-working={(isCurrent ? chatState.streaming : elsewhereWorking) ? "1" : "0"}
            style={{ width: 8, height: 8, borderRadius: "50%", display: "inline-block" }}
          />
          {!isCurrent && <ArrowUpRight size={11} style={{ color: "var(--fg-secondary)", opacity: 0.75 }} />}
        </span>
      )}
      {editingId === s.id ? (
        <input
          type="text"
          value={editTitle}
          onChange={(e) => setEditTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); commitRename(); }
            if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); cancelRename(); }
          }}
          onBlur={commitRename}
          onClick={(e) => e.stopPropagation()}
          autoFocus
          style={{
            flex: 1, border: "1px solid var(--accent)", borderRadius: 3,
            padding: "2px 6px", fontSize: "calc(var(--font-scale, 1) * 12px)",
            fontFamily: "inherit", outline: "none",
            backgroundColor: "var(--bg-root)", color: "var(--fg-primary)",
          }}
        />
      ) : (
        <span
          style={{
            overflow: "hidden", textOverflow: "ellipsis",
            whiteSpace: "nowrap", flex: 1,
          }}
          onDoubleClick={(e) => {
            e.stopPropagation();
            if (!selectMode) startRename(s);
          }}
          title={t("sessions.rename")}
        >
          {s.title}
        </span>
      )}
      {/* 行内只留两个：收藏（最高频且需看到选中态）+ ⋯（其余操作）。
          重命名 / 移动 / 新窗口 / 删除 / 复制 / 分叉 全在菜单里（右键同样可达）。 */}
      {!selectMode && editingId !== s.id && (
        <>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); toggleFavorite(s.id); }}
            title={favSet.has(s.id) ? t("sessions.unfavorite") : t("sessions.favorite")}
            aria-label={favSet.has(s.id) ? t("sessions.unfavorite") : t("sessions.favorite")}
            style={{
              ...iconBtnStyle, fontSize: 13, marginLeft: 4,
              color: favSet.has(s.id) ? "#f0a500" : "var(--fg-secondary)",
              opacity: favSet.has(s.id) ? 1 : hoveredId === s.id ? 0.6 : 0,
              transition: "opacity 0.1s",
            }}
          >
            {favSet.has(s.id) ? "★" : "☆"}
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              // 锚到按钮右下角展开，而不是鼠标位置 —— 键盘/触屏触发时也有合理落点
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              showCtxMenu(r.right - 4, r.bottom + 4, buildSessionMenu(s));
            }}
            title={t("sessions.more")}
            aria-label={t("sessions.more")}
            style={{
              ...iconBtnStyle, display: "flex", alignItems: "center",
              opacity: favSet.has(s.id) ? 0.55 : hoveredId === s.id ? 0.55 : 0,
              transition: "opacity 0.1s",
              color: "var(--fg-secondary)", marginLeft: 2,
            }}
          >
            <MoreHorizontal size={13} />
          </button>
        </>
      )}
    </div>
    );
  };

  useEffect(() => {
    if (connected) requestSessionList();
  }, [connected]);

  // Exit select mode when sessions change (deletion happened)
  useEffect(() => {
    if (selectMode && selectedIds.size > 0) {
      const currentIds = new Set(sessions.map((s) => s.id));
      const stillExists = new Set([...selectedIds].filter((id) => currentIds.has(id)));
      if (stillExists.size < selectedIds.size) {
        setSelectedIds(stillExists);
      }
    }
  }, [sessions]);

  // Clear selections when exiting select mode
  useEffect(() => {
    if (!selectMode) setSelectedIds(new Set());
  }, [selectMode]);

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleSingleDelete = () => {
    if (!deleteTarget) return;
    const sid = deleteTarget.id;
    // 删除即从文件夹归属中移除 — 不依赖被动孤儿清理(它可能被启动竞态跳过),
    // 也避免残留 dangling assignment。
    if (Object.prototype.hasOwnProperty.call(folderTree.assignments, sid)) {
      saveFolderTree(unassignSession(folderTree, sid));
    }
    const cur = getChatState();
    const isActive = cur.sessionId === sid;
    removeSession(sid);
    setDeleteTarget(null);
    // 删除的是当前打开的会话 → 切到列表里另一个会话（或新建空会话），避免残留已删会话信息
    if (isActive) {
      const next = cur.sessions.find((s) => s.id !== sid);
      if (next) switchSession(next.id);
      else createSession();
    }
    setTimeout(requestSessionList, 1000);
  };

  const handleBatchDelete = () => {
    const ids = [...selectedIds];
    setBatchDeleteCount(0);
    setSelectMode(false);
    setSelectedIds(new Set());
    // 批量删除：先一次性从文件夹归属中移除全部目标会话
    const withRemoved = { ...folderTree, assignments: { ...folderTree.assignments } };
    for (const sid of ids) delete withRemoved.assignments[sid];
    if (ids.some((id) => Object.prototype.hasOwnProperty.call(folderTree.assignments, id))) {
      saveFolderTree(withRemoved);
    }
    // Delete sequentially with delays
    ids.forEach((id, i) => {
      setTimeout(() => removeSession(id), i * 500);
    });
    // 批量删除含当前打开的会话 → 切到未删的会话（或新建空会话），避免残留已删会话信息
    const cur = getChatState();
    if (cur.sessionId && ids.includes(cur.sessionId)) {
      const next = cur.sessions.find((s) => !ids.includes(s.id));
      setTimeout(() => {
        if (next) switchSession(next.id);
        else createSession();
      }, ids.length * 500 + 200);
    }
    setTimeout(requestSessionList, ids.length * 500 + 1000);
  };

  const selCount = selectedIds.size;

  const startRename = useCallback((s: Session) => {
    setEditingId(s.id);
    setEditTitle(s.title);
  }, []);

  const commitRename = useCallback(() => {
    if (editingId && editTitle.trim()) {
      renameSession(editingId, editTitle.trim());
    }
    setEditingId(null);
    setEditTitle("");
  }, [editingId, editTitle]);

  const cancelRename = useCallback(() => {
    setEditingId(null);
    setEditTitle("");
  }, []);

  return (
    <div
      style={{
        display: "flex", flexDirection: "column", height: "100%",
        fontFamily: "var(--font-sans)", fontSize: "calc(var(--font-scale, 1) * 12px)",
      }}
    >
      <style>{`
        .session-status-dot {
          background: var(--fg-muted);
          opacity: 0.55;
          transition: background 0.2s, opacity 0.2s;
        }
        .session-status-dot[data-working="1"] {
          background: var(--semantic-warning);
          opacity: 1;
          animation: sess-status-pulse 1.4s ease-in-out infinite;
        }
        @keyframes sess-status-pulse {
          0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--semantic-warning) 45%, transparent); }
          50% { box-shadow: 0 0 0 4px transparent; }
        }
      `}</style>
      {/* Confirm modal */}
      {deleteTarget && (
        <ConfirmDialog
          count={1}
          title={deleteTarget.title}
          onConfirm={handleSingleDelete}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
      {batchDeleteCount > 0 && (
        <ConfirmDialog
          count={batchDeleteCount}
          onConfirm={handleBatchDelete}
          onCancel={() => setBatchDeleteCount(0)}
        />
      )}
      {/* 软警告：会话已在另一窗口打开，确认后再切换（best-effort 不强制互斥） */}
      {confirmOpenElsewhere && (
        <div
          onClick={() => setConfirmOpenElsewhere(null)}
          style={{ position: "fixed", inset: 0, zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center", backgroundColor: "rgba(0,0,0,0.3)" }}
        >
          <div onClick={(e) => e.stopPropagation()} style={{ backgroundColor: "var(--bg-root)", borderRadius: 8, boxShadow: "0 8px 32px rgba(0,0,0,0.2)", padding: 20, minWidth: 280, maxWidth: 400, fontFamily: "var(--font-sans)" }}>
            <div style={{ color: "var(--fg-primary)", fontWeight: 600, marginBottom: 8 }}>{t("sessions.openElsewhereTitle")}</div>
            <div style={{ color: "var(--fg-secondary)", marginBottom: 14 }}>{t("sessions.openElsewhereWarn", { title: confirmOpenElsewhere.title })}</div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button type="button" onClick={() => setConfirmOpenElsewhere(null)} style={dialogBtn("var(--bg-root)", "var(--border-medium)", "var(--fg-primary)")}>{t("sessions.cancel")}</button>
              <button
                type="button"
                onClick={() => {
                  const sid = confirmOpenElsewhere.id;
                  setConfirmOpenElsewhere(null);
                  switchSession(sid);
                  commandRegistry.execute(Commands.CHAT_FOCUS_INPUT);
                }}
                style={dialogBtn("var(--semantic-error)", "none", "var(--fg-inverse)")}
              >
                {t("sessions.openAnyway")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 切会话打断确认：后端忙时切换会 abort 当前回合 */}
      {confirmBusySwitch && (
        <div
          onClick={() => setConfirmBusySwitch(null)}
          style={{ position: "fixed", inset: 0, zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center", backgroundColor: "rgba(0,0,0,0.3)" }}
        >
          <div onClick={(e) => e.stopPropagation()} style={{ backgroundColor: "var(--bg-root)", borderRadius: 8, boxShadow: "0 8px 32px rgba(0,0,0,0.2)", padding: 20, minWidth: 280, maxWidth: 400, fontFamily: "var(--font-sans)" }}>
            <div style={{ color: "var(--fg-primary)", fontWeight: 600, marginBottom: 8 }}>{t("sessions.switchBusyTitle")}</div>
            <div style={{ color: "var(--fg-secondary)", marginBottom: 14, lineHeight: 1.4 }}>{t("sessions.switchBusyWarn", { title: confirmBusySwitch.title })}</div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button type="button" onClick={() => setConfirmBusySwitch(null)} style={dialogBtn("var(--bg-root)", "var(--border-medium)", "var(--fg-primary)")}>{t("sessions.cancel")}</button>
              <button
                type="button"
                onClick={() => {
                  const sid = confirmBusySwitch.id;
                  setConfirmBusySwitch(null);
                  switchSession(sid);
                  commandRegistry.execute(Commands.CHAT_FOCUS_INPUT);
                }}
                style={dialogBtn("var(--semantic-error)", "none", "var(--fg-inverse)")}
              >
                {t("sessions.switchAnyway")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <div
        style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "8px 10px", borderBottom: "1px solid var(--border-light)",
          fontWeight: 600, color: "var(--fg-primary)",
        }}
      >
        <span>{selectMode ? t("sessions.selectTitle", { count: selCount }) : t("sessions.title")}</span>
        <div style={{ display: "flex", gap: 4 }}>
          <button
            type="button"
            onClick={() => requestSessionList()}
            title={t("sessions.refresh")}
            aria-label={t("sessions.refresh")}
            style={iconBtnStyle}
          >
            ↻
          </button>
          <button
            type="button"
            onClick={() => createSession()}
            title={t("sessions.newSession")}
            aria-label={t("sessions.newSession")}
            style={{ ...iconBtnStyle, color: "var(--accent)", fontWeight: 700 }}
          >
            +
          </button>
          <button
            type="button"
            onClick={() => setSelectMode((prev) => !prev)}
            title={selectMode ? t("sessions.cancel") : t("sessions.select")}
            aria-label={selectMode ? t("sessions.cancel") : t("sessions.select")}
            style={{
              ...iconBtnStyle,
              color: selectMode ? "var(--semantic-error)" : "var(--fg-secondary)",
              display: "flex",
              alignItems: "center",
            }}
          >
            <ListChecks size={14} />
          </button>
        </div>
      </div>

      {/* List */}
      <div style={{ flex: 1, overflow: "auto" }}>
        {!connected && (
          <div style={{ padding: 16, color: "var(--fg-muted)", textAlign: "center" }}>
            {t("sessions.notConnected")}
          </div>
        )}
        {connected && sessions.length === 0 && !showFavs && (
          <div style={{ padding: 16, color: "var(--fg-muted)", textAlign: "center" }}>
            {t("sessions.noSessions")}
          </div>
        )}
        {showFavs && (
          <>
            <div style={{ padding: "4px 10px", fontSize: 10, color: "var(--fg-muted)", fontFamily: "var(--font-sans)", fontWeight: 600 }}>
              {t("sessions.favoritesTitle")}
            </div>
            {shownStaleFavIds.map((id) => (
              <div
                key={id}
                style={{
                  display: "flex", alignItems: "center", gap: 6,
                  padding: "6px 10px", borderBottom: "1px solid var(--border-light)",
                  color: "var(--fg-muted)", userSelect: "none",
                }}
              >
                <span style={{ color: "var(--fg-muted)", flexShrink: 0, width: 14, textAlign: "center" }}>★</span>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, fontStyle: "italic" }} title={id}>
                  {id}
                </span>
                <span style={{ fontSize: "calc(var(--font-scale, 1) * 10px)", color: "var(--fg-muted)", flexShrink: 0 }} title={t("sessions.staleFavorite")}>
                  {t("sessions.staleFavorite")}
                </span>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); toggleFavorite(id); }}
                  title={t("sessions.removeFavorite")}
                  aria-label={t("sessions.removeFavorite")}
                  style={{ ...iconBtnStyle, fontSize: 12, opacity: 0.6, marginLeft: 2 }}
                >
                  ×
                </button>
              </div>
            ))}
            {favSessions.map((s) => renderSessionRow(s))}
            <div style={{ height: 1, backgroundColor: "var(--border-light)", margin: "4px 10px" }} />
          </>
        )}
        {foldersEnabled ? (
          <>
            {/* 文件夹区域头部 */}
            <div style={{ padding: "4px 10px", display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontSize: 10, color: "var(--fg-muted)", fontFamily: "var(--font-sans)", fontWeight: 600, flex: 1 }}>
                {t("sessions.foldersTitle")}
              </span>
              <button
                type="button"
                onClick={() => { setNewFolderParent(null); setNewFolderName(""); }}
                title={t("sessions.newFolder")}
                aria-label={t("sessions.newFolder")}
                style={{ ...iconBtnStyle, color: "var(--accent)", fontWeight: 600, fontSize: "calc(var(--font-scale, 1) * 10px)", padding: "2px 4px", display: "flex", alignItems: "center", gap: 2 }}
              >
                <Plus size={11} /> {t("sessions.newFolder")}
              </button>
            </div>
            {newFolderParent === null && (
              <div style={{ padding: "2px 10px" }}>
                <input
                  type="text" autoFocus value={newFolderName}
                  onChange={(e) => setNewFolderName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); confirmNewFolder(); } if (e.key === "Escape") setNewFolderParent(undefined); }}
                  onBlur={confirmNewFolder}
                  placeholder={t("sessions.folderNamePlaceholder")}
                  style={{ width: "100%", border: "1px solid var(--accent)", borderRadius: 3, padding: "2px 6px", fontSize: "calc(var(--font-scale, 1) * 12px)", background: "var(--bg-root)", color: "var(--fg-primary)", outline: "none" }}
                />
              </div>
            )}
            {folderNodes.map((node) => renderFolderNode(node, 0))}
            <div style={{ height: 1, backgroundColor: "var(--border-light)", margin: "4px 10px" }} />
            <div style={{ padding: "4px 10px", fontSize: 10, color: "var(--fg-muted)", fontFamily: "var(--font-sans)", fontWeight: 600 }}>
              {t("sessions.uncategorized")}
            </div>
            {folderPartition.uncategorized.map((s) => renderSessionRow(s))}
          </>
        ) : (
          regularSessions.map((s) => renderSessionRow(s))
        )}
        {selectMode && sessions.length > 0 && selCount > 0 && (
          <div
            style={{
              position: "sticky", bottom: 0,
              display: "flex", alignItems: "center", justifyContent: "space-between",
              padding: "8px 10px",
              backgroundColor: "var(--semantic-warning-subtle)", borderTop: "1px solid var(--border-light)",
              fontSize: "calc(var(--font-scale, 1) * 12px)", color: "var(--semantic-warning)",
            }}
          >
            <span>{t("sessions.selectedCount", { count: selCount })}</span>
            <div style={{ display: "flex", gap: 6 }}>
              <button
                type="button"
                onClick={() => { setSelectMode(false); setSelectedIds(new Set()); }}
                style={barBtn("var(--bg-root)", "var(--border-medium)", "var(--fg-primary)")}
              >
                {t("sessions.cancel")}
              </button>
              <button
                type="button"
                onClick={() => setBatchDeleteCount(selCount)}
                style={barBtn("var(--semantic-error)", "var(--semantic-error)", "var(--fg-inverse)")}
              >
                {t("sessions.deleteSelected", { count: selCount })}
              </button>
              {foldersEnabled && (
                <button
                  type="button"
                  onClick={() => setMovePickerFor([...selectedIds])}
                  style={barBtn("var(--accent)", "var(--accent)", "var(--fg-inverse)")}
                >
                  {t("sessions.moveSelected")}
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* 文件夹删除确认 */}
      {deleteFolderTarget && (
        <div
          style={{ position: "fixed", inset: 0, zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center", backgroundColor: "rgba(0,0,0,0.3)" }}
          onClick={() => setDeleteFolderTarget(null)}
        >
          <div onClick={(e) => e.stopPropagation()} style={{ backgroundColor: "var(--bg-root)", borderRadius: 8, boxShadow: "0 8px 32px rgba(0,0,0,0.2)", padding: 20, minWidth: 280, maxWidth: 400, fontFamily: "var(--font-sans)" }}>
            <div style={{ fontSize: "calc(var(--font-scale, 1) * 14px)", fontWeight: 600, color: "var(--fg-primary)", marginBottom: 10 }}>
              {t("sessions.deleteFolderTitle")}
            </div>
            <div style={{ fontSize: "calc(var(--font-scale, 1) * 13px)", color: "var(--fg-secondary)", marginBottom: 18, lineHeight: 1.4 }}>
              {t("sessions.deleteFolderMessage", { name: deleteFolderTarget.name })}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button onClick={() => setDeleteFolderTarget(null)} style={barBtn("var(--bg-root)", "var(--border-medium)", "var(--fg-primary)")}>{t("sessions.cancel")}</button>
              <button onClick={confirmDeleteFolder} style={barBtn("var(--semantic-error)", "var(--semantic-error)", "var(--fg-inverse)")}>{t("sessions.delete")}</button>
            </div>
          </div>
        </div>
      )}

      {/* 移动到文件夹选择器 */}
      {movePickerFor && (
        <FolderPicker
          folderNodes={folderNodes}
          onPick={(folderId) => {
            saveFolderTree(moveSessions(folderTree, movePickerFor, folderId));
            setMovePickerFor(null);
          }}
          onClose={() => setMovePickerFor(null)}
        />
      )}

      {/* 文件夹重定位选择器（排除自身/后代, 可移回根目录） */}
      {reparentFolderFor && (
        <FolderReparentPicker
          folderNodes={folderNodes}
          movingId={reparentFolderFor}
          onPick={(newParentId) => {
            saveFolderTree(moveFolder(folderTree, reparentFolderFor, newParentId ?? undefined));
            setReparentFolderFor(null);
          }}
          onClose={() => setReparentFolderFor(null)}
        />
      )}
    </div>
  );
}

function FolderReparentPicker({ folderNodes, movingId, onPick, onClose }: {
  folderNodes: FolderNode[];
  movingId: string;
  onPick: (newParentId: string | null) => void;
  onClose: () => void;
}) {
  // 排除自身 + 后代（防环）
  const excluded = new Set<string>([movingId]);
  const collect = (nodes: FolderNode[], rootId: string) => {
    for (const n of nodes) {
      if (n.folder.id === rootId) {
        const walk = (nn: FolderNode) => {
          excluded.add(nn.folder.id);
          nn.children.forEach(walk);
        };
        n.children.forEach(walk);
        return;
      }
    }
    nodes.forEach((n) => collect(n.children, rootId));
  };
  collect(folderNodes, movingId);

  const renderNode = (node: FolderNode, depth: number): React.ReactNode => (
    <div key={node.folder.id}>
      <div
        style={{
          display: "flex", alignItems: "center", gap: 4,
          padding: "5px 10px 5px " + (10 + depth * 14) + "px", cursor: "pointer",
          fontSize: "calc(var(--font-scale, 1) * 12px)", fontFamily: "var(--font-sans)",
          color: excluded.has(node.folder.id) ? "var(--fg-muted)" : "var(--fg-primary)",
          pointerEvents: excluded.has(node.folder.id) ? "none" : "auto",
        }}
        onClick={() => onPick(node.folder.id)}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = "var(--bg-hover)"; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = "transparent"; }}
      >
        <Folder size={13} style={{ color: "var(--accent)", opacity: 0.85, flexShrink: 0 }} />
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{node.folder.name}</span>
      </div>
      {node.children.map((c) => renderNode(c, depth + 1))}
    </div>
  );
  return (
    <div
      style={{ position: "fixed", inset: 0, zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center", backgroundColor: "rgba(0,0,0,0.3)" }}
      onClick={onClose}
    >
      <div onClick={(e) => e.stopPropagation()} style={{ backgroundColor: "var(--bg-root)", borderRadius: 8, boxShadow: "0 8px 32px rgba(0,0,0,0.2)", padding: 10, minWidth: 220, maxWidth: 320, maxHeight: 320, overflow: "auto", fontFamily: "var(--font-sans)" }}>
        <div style={{ padding: "2px 10px 6px", fontSize: 10, color: "var(--fg-muted)", fontWeight: 600 }}>{t("sessions.moveFolder")}</div>
        {folderNodes.length <= 1 && <div style={{ padding: "8px 10px", fontSize: 12, color: "var(--fg-muted)" }}>{t("sessions.noMoveTargets")}</div>}
        {folderNodes.map((n) => renderNode(n, 0))}
        <div
          style={{ padding: "4px 10px", cursor: "pointer", fontSize: "calc(var(--font-scale, 1) * 12px)", color: "var(--fg-secondary)", borderTop: "1px solid var(--border-light)", marginTop: 4 }}
          onClick={() => onPick(null)}
        >
          {t("sessions.rootLevel")}
        </div>
      </div>
    </div>
  );
}

function FolderPicker({ folderNodes, onPick, onClose }: {
  folderNodes: FolderNode[];
  onPick: (folderId: string | null) => void;
  onClose: () => void;
}) {
  const renderNode = (node: FolderNode, depth: number): React.ReactNode => (
    <div key={node.folder.id}>
      <div
        style={{
          display: "flex", alignItems: "center", gap: 4,
          padding: "5px 10px 5px " + (10 + depth * 14) + "px", cursor: "pointer",
          fontSize: "calc(var(--font-scale, 1) * 12px)", fontFamily: "var(--font-sans)", color: "var(--fg-primary)",
        }}
        onClick={() => onPick(node.folder.id)}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = "var(--bg-hover)"; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = "transparent"; }}
      >
        <Folder size={13} style={{ color: "var(--accent)", opacity: 0.85, flexShrink: 0 }} />
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{node.folder.name}</span>
      </div>
      {node.children.map((c) => renderNode(c, depth + 1))}
    </div>
  );
  return (
    <div
      style={{ position: "fixed", inset: 0, zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center", backgroundColor: "rgba(0,0,0,0.3)" }}
      onClick={onClose}
    >
      <div onClick={(e) => e.stopPropagation()} style={{ backgroundColor: "var(--bg-root)", borderRadius: 8, boxShadow: "0 8px 32px rgba(0,0,0,0.2)", padding: 10, minWidth: 220, maxWidth: 320, maxHeight: 320, overflow: "auto", fontFamily: "var(--font-sans)" }}>
        <div style={{ padding: "2px 10px 6px", fontSize: 10, color: "var(--fg-muted)", fontWeight: 600 }}>{t("sessions.moveToFolder")}</div>
        {folderNodes.length === 0 && <div style={{ padding: "8px 10px", fontSize: 12, color: "var(--fg-muted)" }}>{t("sessions.noFolders")}</div>}
        {folderNodes.map((n) => renderNode(n, 0))}
        <div
          style={{ padding: "4px 10px", cursor: "pointer", fontSize: "calc(var(--font-scale, 1) * 12px)", color: "var(--fg-secondary)", borderTop: "1px solid var(--border-light)", marginTop: 4 }}
          onClick={() => onPick(null)}
        >
          {t("sessions.uncategorized")}
        </div>
      </div>
    </div>
  );
}

const iconBtnStyle: React.CSSProperties = {
  border: "none", background: "none", cursor: "pointer",
  fontSize: "calc(var(--font-scale, 1) * 14px)", color: "var(--fg-secondary)", padding: "2px 6px", borderRadius: 3,
};

function barBtn(bg: string, border: string, color: string): React.CSSProperties {
  return {
    padding: "4px 12px", border: `1px solid ${border}`, borderRadius: 4,
    backgroundColor: bg, cursor: "pointer", fontSize: "calc(var(--font-scale, 1) * 12px)", color, fontWeight: bg === "var(--semantic-error)" ? 600 : 400,
  };
}
export const SessionPanel = memo(SessionPanelImpl);
