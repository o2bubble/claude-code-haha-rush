import React, { useEffect } from "react";
import type { DesktopItem, RefContent } from "../../types/desktop";
import { openReference } from "../../services/referenceActions";
import { registerDataSource, unloadDataSource } from "../../services/dataRegistry";

interface Props {
  item: DesktopItem;
}

export function RefItem({ item }: Props) {
  const content = item.content as RefContent;

  useEffect(() => {
    registerDataSource({
      itemId: item.id,
      desktopId: item.desktopId,
      label: item.label,
      contentType: "ref",
      dataKeys: ["paths", "files"],
      queryHandler: (key: string) => {
        const paths = content.references.map((r) => r.path);
        switch (key) {
          case "paths": return { keys: ["paths"], value: paths };
          case "files": return { keys: ["files"], value: paths };
          default: return undefined;
        }
      },
    });
    return () => unloadDataSource(item.id);
  }, [item.id, item.desktopId, item.label, content.references]);

  return (
    <div style={{ padding: 8 }}>
      {content.note && (
        <div style={{ fontSize: 12, color: "var(--fg-secondary)", marginBottom: 6, whiteSpace: "pre-wrap" }}>
          {content.note}
        </div>
      )}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
        {content.references.map((ref, i) => {
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
