import { useState } from "react";
import { getCurrentViewerItemId } from "../../services/desktopItemViewerRegistry";
import { getDesktopItem } from "../../stores/desktopStore";
import { useEvent } from "../../services/useService";
import { Events } from "../../services/events";
import { t } from "../../i18n";
import { renderItemContent } from "../../services/itemTypeRegistry";

export function DesktopItemViewer() {
  const [itemId] = useState(() => getCurrentViewerItemId());

  if (!itemId) {
    return <div style={{ padding: 24, color: "var(--fg-muted)", fontFamily: "var(--font-sans)" }}>{t("desktopItemViewer.noItem")}</div>;
  }

  return <DesktopItemViewerContent key={itemId} itemId={itemId} />;
}

function DesktopItemViewerContent({ itemId }: { itemId: string }) {
  // Re-render only when desktop data actually changes (not on a timer)
  const payload = useEvent(Events.DESKTOP_CHANGED);

  const item = getDesktopItem(itemId);
  if (!item) {
    // If no desktop data at all yet, show loading (Leaf sync may be in progress)
    const hasAnyData = payload && (payload as any)?.desktops?.length > 0;
    return (
      <div style={{ padding: 24, color: "var(--fg-muted)", fontFamily: "var(--font-sans)" }}>
        {hasAnyData ? t("desktopItemViewer.itemDeleted") : t("desktopItemViewer.loadingItem")}
      </div>
    );
  }

  return (
    renderItemContent(item) ?? (
      <div style={{ padding: 24, color: "var(--fg-muted)", fontFamily: "var(--font-sans)" }}>
        {t("desktopItemViewer.unknownType", { type: (item.content as any).type })}
      </div>
    )
  );
}
