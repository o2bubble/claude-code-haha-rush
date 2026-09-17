// ── 设置 → 快捷键 ──
//
// 快捷键的管理界面：查看 / 改键 / 冲突提示 / 恢复默认。
//
// **条目来源**：内置表（`DEFAULT_SHORTCUTS`）+ **插件命令**（`plugin.json` 的
// `commands[].hotkey`，运行时收集）。插件条目没有 i18n 键，靠条目自带的 `label`
// 显示（`label ?? t(labelKey)`）—— 直接 `t("")` 会把空键名印在界面上。
//
// **可改性**（决定只读与否）：
//   · 全局 / 命令型 / 插件条目 —— 可改键
//   · 上下文型（`contextual: true`）—— **只读展示**。它们有额外生效条件
//     （笔记面板聚焦、文件树有选中项…），改了键也可能不生效，让用户改是误导。
//   · `scope: "os"`（全局热键）—— 可改，但录制时用更严的校验
//     （见下方 `isGlobalHotkeyBindable`）。
//
// **软冲突**：允许绑到同一个键，但列表里用警示色标出 + 顶部汇总提示。
// 运行时按注册表顺序（靠前者优先），与注册时机解耦。

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, RotateCcw, X } from "lucide-react";
import { t } from "../../i18n";
import {
  DEFAULT_SHORTCUTS, resolveBindings, findConflicts, displayKeys, normalizeKeys,
  formatKeys, isBindableKeys, isGlobalHotkeyBindable, buildPluginShortcutEntries,
  BARE_MODIFIER_KEYS,
  type ShortcutEntry,
} from "../../services/shortcuts";
import { getActiveManifests, collectPluginHotkeys } from "../../services/pluginRegistry";
import {
  getGlobalHotkeyStatus, subscribeGlobalHotkeyStatus, type HotkeyStatus,
} from "../../services/globalShortcutService";
import { useEventHandler } from "../../services/useService";
import { Events } from "../../services/events";
import { S } from "./settingsStyles";
import { isMacPlatform } from "../../services/shortcutDispatcher";

/** 分组显示顺序与标题。 */
const GROUP_ORDER: Array<{ id: string; labelKey: string }> = [
  { id: "global", labelKey: "shortcuts.group.global" },
  { id: "layout", labelKey: "shortcuts.group.layout" },
  { id: "notes", labelKey: "shortcuts.group.notes" },
  { id: "files", labelKey: "shortcuts.group.files" },
  { id: "plugins", labelKey: "shortcuts.group.plugins" },
];

export default function ShortcutsPanel({
  overrides,
  onChange,
}: {
  overrides: Record<string, string> | undefined;
  /** 写入用户覆盖（id → 键位；空串 = 解绑） */
  onChange: (next: Record<string, string>) => void;
}) {
  const isMac = useMemo(isMacPlatform, []);
  const [recording, setRecording] = useState<string | null>(null);
  /** 录制时按了不可绑的键 → 显示提示（不静默吞掉） */
  const [rejected, setRejected] = useState<string | null>(null);
  /** 插件重扫时刷新（装/卸插件后条目要跟着变） */
  const [pluginTick, setPluginTick] = useState(0);
  /** 全局热键的注册结果（id → 该键是否真的注册上了） */
  const [hotkeyStatus, setHotkeyStatus] = useState<HotkeyStatus[]>(getGlobalHotkeyStatus);

  useEventHandler(Events.PANEL_REGISTRY_CHANGED, () => setPluginTick((v) => v + 1));
  useEffect(() => subscribeGlobalHotkeyStatus(setHotkeyStatus), []);
  const hotkeyById = useMemo(
    () => new Map(hotkeyStatus.map((s) => [s.id, s])),
    [hotkeyStatus],
  );

  const entries = useMemo(() => {
    const pluginEntries = buildPluginShortcutEntries(
      collectPluginHotkeys(getActiveManifests()),
    );
    // 顺序 = 内置在前、插件在后（与分发器一致，避免面板显示的顺序与实际优先级不符）
    return [
      ...resolveBindings(DEFAULT_SHORTCUTS, overrides),
      ...resolveBindings(pluginEntries, overrides),
    ];
    // pluginTick 刻意进依赖：插件变更是命令式事件，没有其它可观察的依赖源
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overrides, pluginTick]);
  const conflicts = useMemo(() => findConflicts(entries), [entries]);
  const conflictedIds = useMemo(
    () => new Set(conflicts.flatMap((c) => c.ids)),
    [conflicts],
  );

  const setKey = (id: string, keys: string) => {
    const next = { ...(overrides ?? {}) };
    if (keys === "") delete next[id];
    else next[id] = normalizeKeys(keys);
    onChange(next);
  };

  const resetOne = (id: string) => {
    const next = { ...(overrides ?? {}) };
    delete next[id];
    onChange(next);
  };

  const resetAll = () => onChange({});

  const overriddenCount = Object.keys(overrides ?? {}).length;

  /** 按分组归拢条目（保持表内顺序）。 */
  const grouped = useMemo(() => {
    const map = new Map<string, ShortcutEntry[]>();
    for (const e of entries) {
      const list = map.get(e.group);
      if (list) list.push(e);
      else map.set(e.group, [e]);
    }
    return map;
  }, [entries]);

  return (
    <div style={S.form}>
      {/* 顶部：冲突汇总 + 全部重置 */}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ flex: 1 }}>
          {conflicts.length > 0 && (
            <div style={{
              display: "flex", alignItems: "center", gap: 6,
              fontSize: "calc(var(--font-scale, 1) * 11px)",
              color: "var(--semantic-warning)",
            }}>
              <AlertTriangle size={13} />
              {t("shortcuts.conflictWarning", { count: String(conflicts.length) })}
            </div>
          )}
          {rejected && (
            <div style={{
              display: "flex", alignItems: "center", gap: 6,
              fontSize: "calc(var(--font-scale, 1) * 11px)",
              color: "var(--semantic-warning)",
            }}>
              <AlertTriangle size={13} />
              {rejected}
            </div>
          )}
        </div>
        {overriddenCount > 0 && (
          <button
            type="button"
            onClick={resetAll}
            style={{
              display: "flex", alignItems: "center", gap: 4,
              padding: "4px 10px", border: "1px solid var(--border-medium)",
              borderRadius: 4, background: "transparent",
              color: "var(--fg-secondary)", cursor: "pointer",
              fontSize: "calc(var(--font-scale, 1) * 11px)",
            }}
          >
            <RotateCcw size={12} />
            {t("shortcuts.resetAll")}
          </button>
        )}
      </div>

      {/* 分组列表 */}
      {GROUP_ORDER.map((g) => {
        const list = grouped.get(g.id);
        if (!list || list.length === 0) return null;
        return (
          <div key={g.id} style={{ ...S.card, gap: 0 }}>
            <div style={{ ...S.cardTitle, marginBottom: 6 }}>
              <span style={S.cardTitleText}>{t(g.labelKey)}</span>
            </div>
            {list.map((e, i) => {
              const isConflict = conflictedIds.has(e.id);
              const isRecording = recording === e.id;
              const isOverridden = overrides?.[e.id] !== undefined;
              return (
                <div
                  key={e.id}
                  style={{
                    display: "flex", alignItems: "center", gap: 8,
                    padding: "5px 0",
                    borderTop: i === 0 ? "none" : "1px solid var(--border-light)",
                  }}
                >
                  <span style={{
                    flex: 1, minWidth: 0,
                    fontSize: "calc(var(--font-scale, 1) * 12px)",
                    color: "var(--fg-primary)",
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                  }}>
                    {/* 插件条目没有 i18n 键 → 用自带的 label 显示（否则 t("") 出空名） */}
                    {e.label ?? t(e.labelKey)}
                    {e.contextual && (
                      <span style={{
                        marginLeft: 6, fontSize: "calc(var(--font-scale, 1) * 10px)",
                        color: "var(--fg-muted)",
                      }}>
                        {t("shortcuts.contextualBadge")}
                      </span>
                    )}
                    {e.scope === "os" && (
                      <span style={{
                        marginLeft: 6, fontSize: "calc(var(--font-scale, 1) * 10px)",
                        color: "var(--fg-muted)",
                      }}>
                        {t("shortcuts.osBadge")}
                      </span>
                    )}
                  </span>

                  {/* 全局热键的注册结果 —— 注册失败是静默的（键被占时没有任何其它
                      反馈），不显示的话用户只会觉得"时灵时不灵"。
                      三态：**已让位给另一个实例**用中性色（多开的正常现象，不是故障）、
                      **被其它软件占用**才标红（那才需要用户换键）、**已关闭**是用户的选择。 */}
                  {e.scope === "os" && hotkeyById.get(e.id) && (() => {
                    const st = hotkeyById.get(e.id)!;
                    if (st.state === "ok" || st.registered) return null;
                    if (st.state === "disabled") {
                      return (
                        <span
                          title={t("shortcuts.osDisabledHint")}
                          style={{
                            fontSize: "calc(var(--font-scale, 1) * 10px)",
                            color: "var(--fg-muted)", whiteSpace: "nowrap",
                          }}
                        >
                          {t("shortcuts.osDisabled")}
                        </span>
                      );
                    }
                    // 键位**本身**不满足全局要求（如绑成 `shift+a`）—— accelerator
                    // 为 null 就是这个信号。别套 osConflict：那会把它误报成"被其它
                    // 软件占用"，而用户真正要做的是换成一个带修饰键的组合。
                    if (!st.accelerator) {
                      return (
                        <span
                          title={st.error ?? ""}
                          style={{
                            fontSize: "calc(var(--font-scale, 1) * 10px)",
                            color: "var(--fg-muted)", whiteSpace: "nowrap",
                          }}
                        >
                          {st.error ?? t("shortcuts.osConflict")}
                        </span>
                      );
                    }
                    const byInstance = st.takenBy === "instance";
                    return (
                      <span
                        title={byInstance ? t("shortcuts.osRetryHint") : (st.error ?? "")}
                        style={{
                          fontSize: "calc(var(--font-scale, 1) * 10px)",
                          color: byInstance ? "var(--fg-muted)" : "var(--semantic-error, #d32f2f)",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {byInstance ? t("shortcuts.osTakenByInstance") : t("shortcuts.osConflict")}
                      </span>
                    );
                  })()}

                  {/* 键位 —— 点击录制（仅上下文型不可改：它的生效条件不可控） */}
                  {e.contextual ? (
                    <ReadonlyKeys keys={e.keys} isMac={isMac} />
                  ) : (
                    <button
                      type="button"
                      onClick={() => { setRecording(isRecording ? null : e.id); setRejected(null); }}
                      onKeyDown={(ev) => {
                        if (!isRecording) return;
                        ev.preventDefault();
                        ev.stopPropagation();
                        if (ev.key === "Escape") { setRecording(null); return; }
                        // 忽略纯修饰键 —— 用户按 Ctrl 时不该立即定稿
                        if (BARE_MODIFIER_KEYS.has(ev.key)) return;

                        // 用 formatKeys 而非手写 join：它能正确处理 `key === "+"` 这类
                        // 边界（手写 join("+") 会把 Ctrl+加号 拼成 "mod+"，解析后只剩
                        // 修饰键 → 静默解绑）。同时保证与表内格式一致（归一化）。
                        const candidate = formatKeys({
                          mod: ev.ctrlKey || ev.metaKey,
                          ctrl: false, alt: ev.altKey, shift: ev.shiftKey,
                          key: ev.key.toLowerCase(),
                        });

                        // 局部交互键（Enter/Esc/方向键…）不可绑为应用级快捷键 ——
                        // 给明确反馈，不静默吞掉
                        if (!isBindableKeys(candidate)) {
                          setRejected(t("shortcuts.notBindable", { keys: displayKeys(candidate, isMac) }));
                          return;
                        }
                        // 全局热键额外要求真正的修饰键（或功能键）：它从**所有应用**
                        // 手里抢键，只按 Shift 的组合会吃掉别处的正常输入
                        if (e.scope === "os" && !isGlobalHotkeyBindable(candidate)) {
                          setRejected(t("shortcuts.osNeedsModifier", { keys: displayKeys(candidate, isMac) }));
                          return;
                        }

                        setKey(e.id, candidate);
                        setRecording(null);
                        setRejected(null);
                      }}
                      style={{
                        minWidth: 96, padding: "3px 8px",
                        border: `1px solid ${isRecording ? "var(--accent)" : isConflict ? "var(--semantic-warning)" : "var(--border-medium)"}`,
                        borderRadius: 4,
                        background: isRecording ? "var(--accent-subtle)" : "transparent",
                        color: isConflict ? "var(--semantic-warning)" : "var(--fg-secondary)",
                        cursor: "pointer",
                        fontFamily: "var(--font-mono, monospace)",
                        fontSize: "calc(var(--font-scale, 1) * 11px)",
                        textAlign: "center",
                      }}
                    >
                      {isRecording
                        ? t("shortcuts.recording")
                        : (e.keys ? displayKeys(e.keys, isMac) : t("shortcuts.unbound"))}
                    </button>
                  )}

                  {/* 单条重置 */}
                  <button
                    type="button"
                    title={t("shortcuts.resetOne")}
                    aria-label={t("shortcuts.resetOne")}
                    onClick={() => resetOne(e.id)}
                    disabled={!isOverridden}
                    style={{
                      display: "flex", alignItems: "center", justifyContent: "center",
                      width: 22, height: 22, flexShrink: 0,
                      border: "none", background: "transparent",
                      borderRadius: 3,
                      color: isOverridden ? "var(--fg-secondary)" : "var(--border-light)",
                      cursor: isOverridden ? "pointer" : "default",
                    }}
                  >
                    {isOverridden ? <X size={12} /> : <RotateCcw size={12} />}
                  </button>
                </div>
              );
            })}
          </div>
        );
      })}

      <div style={{
        fontSize: "calc(var(--font-scale, 1) * 11px)",
        color: "var(--fg-muted)", lineHeight: 1.6,
      }}>
        {t("shortcuts.hint")}
      </div>
    </div>
  );
}

/** 只读键位显示（上下文型 / OS 专属）。 */
function ReadonlyKeys({ keys, isMac }: { keys: string; isMac: boolean }) {
  return (
    <span style={{
      minWidth: 96, padding: "3px 8px",
      border: "1px dashed var(--border-light)",
      borderRadius: 4,
      color: "var(--fg-muted)",
      fontFamily: "var(--font-mono, monospace)",
      fontSize: "calc(var(--font-scale, 1) * 11px)",
      textAlign: "center",
    }}>
      {keys ? displayKeys(keys, isMac) : t("shortcuts.unbound")}
    </span>
  );
}
