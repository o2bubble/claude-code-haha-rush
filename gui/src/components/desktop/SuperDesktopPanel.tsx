import React, { useEffect, useState, useCallback } from "react";
import { t } from "../../i18n";
import { EmptyState, ErrorState } from "../SharedStates";
import { useEvent } from "../../services/useService";
import { windowBus } from "../../services/windowBus";
import { Events } from "../../services/events";
import type { DesktopChangedPayload } from "../../services/events";
import {
  getActiveDesktop, getDesktops, createDesktop, loadDesktops, resetDesktopsLoad,
  getDesktopLoadError, hasLoadedDesktops, searchItems,
} from "../../stores/desktopStore";
import { startMcpBridge } from "../../services/mcpBridge";
import { DesktopTabs } from "./DesktopTabs";
import { CanvasToolbar } from "./CanvasToolbar";
import { SuperDesktopCanvas } from "./SuperDesktopCanvas";
import { LoadingSpinner } from "../SharedStates";

export function SuperDesktopPanel() {
  const payload = useEvent<DesktopChangedPayload>(Events.DESKTOP_CHANGED);
  const [searchQuery, setSearchQuery] = useState("");
  // 已加载过则直接显示 store 缓存，不重复 loading（桌面数据缓存在 desktopStore）
  const [loading, setLoading] = useState(!hasLoadedDesktops());
  const [loadFailed, setLoadFailed] = useState(false);

  // 加载：首次真正拉取；已加载过则 loadDesktops 立即 resolve，不重复读 DB。
  // loadDesktops() 内部有超时且永不 reject，loading 不会永久转圈。
  const finishLoad = useCallback(() => {
    loadDesktops().then(() => {
      if (getDesktopLoadError()) {
        setLoadFailed(true);
      } else if (getDesktops().length === 0) {
        createDesktop("Desktop 1");
      }
      setLoading(false);
    });
  }, []);

  // 重试：清加载缓存重新走一遍（仅失败态按钮触发）
  const retry = useCallback(() => {
    setLoadFailed(false);
    setLoading(true);
    resetDesktopsLoad();
    finishLoad();
  }, [finishLoad]);

  useEffect(() => {
    startMcpBridge();
    finishLoad();
  }, [finishLoad]);

  // Reload desktops when the backend re-binds to a different workspace — the
  // desktopStore cache is reset on WORKSPACE_BOUND, but this panel is already
  // mounted (its mount effect won't re-run), so without this listener the new
  // workspace's desktops would never load. loadDesktops is idempotent
  // (_loadPromise dedup) and WORKSPACE_BOUND is sticky, so this also covers
  // the first bind before the panel mounts.
  useEffect(() => {
    return windowBus.on(Events.WORKSPACE_BOUND, () => {
      finishLoad();
    });
  }, [finishLoad]);

  const desktop = getActiveDesktop();
  const desktops = payload?.desktops ?? getDesktops();
  const activeId = payload?.activeDesktopId ?? desktop?.id ?? null;

  const handleSearch = useCallback((q: string) => setSearchQuery(q), []);

  // Compute matched item ids for dimming
  const matchedIds = searchQuery.trim()
    ? new Set(searchItems(searchQuery, desktop?.id).map((i) => i.id))
    : null;

  if (loading) {
    return <LoadingSpinner text={t("common.loading")} />;
  }
  if (loadFailed) {
    return (
      <ErrorState
        message={t("desktop.loadFailed")}
        onRetry={() => retry()}
      />
    );
  }
  if (!desktop) {
    return <EmptyState text={t("desktop.noDesktop")} />;
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        overflow: "hidden",
      }}
    >
      {/* Tab bar */}
      <DesktopTabs desktops={desktops} activeDesktopId={activeId} />

      {/* Toolbar */}
      <CanvasToolbar desktop={desktop} searchQuery={searchQuery} onSearch={handleSearch} />

      {/* Canvas area */}
      <SuperDesktopCanvas key={desktop.id} desktop={desktop} searchMatchedIds={matchedIds} />
    </div>
  );
}
