import React, { useEffect, useMemo } from "react";
import type { DesktopItem, RefContent } from "../../types/desktop";
import { openReference } from "../../services/referenceActions";
import { registerDataSource, unloadDataSource } from "../../services/dataRegistry";
import { t } from "../../i18n";

interface Props {
  item: DesktopItem;
}

export function RefItem({ item }: Props) {
  const content = item.content as RefContent;

  // 数据契约防御：块内容可能不完整（AI 经 MCP 创建时漏字段，如 references:[{type,label}]
  // 少了 path）。渲染期抛错会被 ErrorBoundary 捕获 —— **整个超级桌面一起消失**，
  // 代价远大于"少显示一条引用"。故在此过滤无效条目，并把丢弃数量显式告知用户。
  const refs = useMemo(() => {
    const list = Array.isArray(content.references) ? content.references : [];
    return list.filter(
      (r): r is (typeof list)[number] =>
        !!r && typeof r === "object" && typeof r.path === "string" && r.path.length > 0,
    );
  }, [content.references]);
  const rawCount = Array.isArray(content.references) ? content.references.length : 0;
  const dropped = rawCount - refs.length;

  useEffect(() => {
    registerDataSource({
      itemId: item.id,
      desktopId: item.desktopId,
      label: item.label,
      contentType: "ref",
      dataKeys: ["paths", "files"],
      queryHandler: (key: string) => {
        const paths = refs.map((r) => r.path);
        switch (key) {
          case "paths": return { keys: ["paths"], value: paths };
          case "files": return { keys: ["files"], value: paths };
          default: return undefined;
        }
      },
    });
    return () => unloadDataSource(item.id);
  }, [item.id, item.desktopId, item.label, refs]);

  return (
    <div style={{ padding: 8 }}>
      {content.note && (
        <div style={{ fontSize: 12, color: "var(--fg-secondary)", marginBottom: 6, whiteSpace: "pre-wrap" }}>
          {content.note}
        </div>
      )}
      {dropped > 0 && (
        <div style={{ fontSize: 11, color: "var(--semantic-warning)", marginBottom: 4, fontFamily: "var(--font-sans)" }}>
          {t("desktop.block.droppedRefs", { n: dropped })}
        </div>
      )}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
        {refs.map((ref, i) => {
          const label = ref.label || ref.path.split("/").pop() || ref.path;
          return (
            <span
              key={i}
              onClick={() => openReference(ref)}
              title={ref.path}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 3,
                padding: "2px 8px",
                fontSize: 12,
                fontFamily: "var(--font-sans)",
                backgroundColor: "var(--accent-subtle)",
                border: "1px solid rgba(0,122,204,0.2)",
                borderRadius: 10,
                color: "var(--accent)",
                cursor: "pointer",
                userSelect: "none",
              }}
            >
              {ref.type === "file" ? "📄" : ref.type === "dir" ? "📁" : "📋"} {label}
            </span>
          );
        })}
      </div>
    </div>
  );
}
