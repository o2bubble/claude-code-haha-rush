import React, { memo, useState, useEffect, useCallback, useRef } from "react";
import {
  getSettings,
  loadSettings,
  saveSettings,
  updateSettings,
  type AppSettings,
} from "../../stores/settingsStore";
import { t, setLanguage, getLanguage, type Language } from "../../i18n";
import { DEFAULT_CONTEXT_WARNING_ENABLED, DEFAULT_CONTEXT_WARNING_PERCENT } from "../../utils/contextWarning";
import { DEFAULT_STALL_WAKE_PROMPT } from "../../utils/streamStallDecision";
import { EmptyState } from "../SharedStates";
import { S } from "./settingsStyles";
import ShortcutsPanel from "./ShortcutsPanel";
import { useEventHandler } from "../../services/useService";
import { Events } from "../../services/events";
import { crossWindowBus } from "../../services/crossWindowBus";
import { usePluginSettings, updatePluginSetting } from "../../services/pluginSettingsStore";
import type { PluginManifest } from "../../services/pluginRegistry";

// ── 压缩配置：handoff 预设（完整复刻技能总结要求）+ 默认脚本路径（随程序打包在 extensions/） ──

const DEFAULT_EXTRACT_SCRIPT = "extensions/handoff-compact/scripts/handoff_extract.py";

const HANDOFF_COMPACT_PRESET = `总结时按信息保真原则，宁可多写不可丢失（token 是次要约束）。
信息按可恢复性分类取舍：下一轮能否自己重新拿到？
- 拿不到（决策/推理产物/已读外部资料）→ 完整复制，核心资产；
- 拿得到且近期要用（git/版本/测试基线）→ 脚本提取，你只需引用，别复述；
- 拿得到但冷（specs/commits/文档）→ 只写「类型+路径+一句话」，不复制；
- 试错过程、来回对话 → 丢弃。
先输出一个 <analysis> 草稿块（自我梳理，会被丢弃），再输出 <summary> 正文块。正文结尾写一行 {{RAW_DATA}}（脚本会把提取的 git/最近消息/已读资料原文替换进该位置）。
不要自行输出"热数据"节（git log/版本/测试基线）——那些脚本已附加在文末，正文最多一句「热数据见文末脚本产物」。

## 会话概览
本会话干了啥（3-5 行，可含下轮焦点）

## 决策留痕表
每条一个块，务必含踩过的坑、用户纠正过的方向（防重蹈覆辙的关键）：
### 决策：<一句话>
- 为什么：<背景/触发原因>
- 影响：<改了哪些子系统/文件>
- 留痕：<commit hash 或 ticket 路径>
要点：为什么 + 影响必须有——光有结论下轮不敢动相关代码，有背景才能判断决策是否仍成立。

## 不可再生资料
每条一个块：
### <条目名>
- 类型：已读资料 | 调查结论
- 来源：<Read 的文件路径> 或 <会话中哪次排查>
- 关键内容：<提炼的核心数据/结论/推理链>
- 对下轮的价值：<这个为什么不能丢，下轮哪会用>
要点：已读资料写提炼要点不贴原文（原文已由脚本附加）；调查结论指追代码/链路得出的推理产物（不在任何单一文件里，最易丢，必须记）。

## 最近对话停点
最后几条用户消息，末尾补一句「停在这里：正在讨论 X」

## 当前状态 / 待办
现在在哪、下一步做什么（含被推迟的项，如"网络恢复后 upload96"）

## 冷数据索引
已持久化的内容引用路径（specs/docs/commits），只写「类型+路径+一句话」，不复制

## Suggested skills
下轮建议调用的 skill 名 + 一句用途

写完自检：假装是下轮会话只读本文档——能回答"上一轮做了啥/为啥？话停在哪？现在该干嘛？关键配置/版本/基线是什么？"吗？缺就补。确认无 API key/密码/PII。`;


// ── Category definitions ──

export interface SettingCategory {
  id: string;
  i18nKey: string;
}

export const CATEGORIES: SettingCategory[] = [
  { id: "general", i18nKey: "settings.catGeneral" },
  { id: "files", i18nKey: "settings.catFiles" },
  { id: "terminal", i18nKey: "settings.catTerminal" },
  { id: "editor", i18nKey: "settings.catEditor" },
  { id: "chat", i18nKey: "settings.catChat" },
  { id: "sessions", i18nKey: "settings.catSessions" },
  { id: "desktop", i18nKey: "settings.catDesktop" },
  { id: "shortcuts", i18nKey: "settings.catShortcuts" },
  { id: "plugins", i18nKey: "settings.catPlugins" },
  { id: "skills", i18nKey: "settings.catSkills" },
  { id: "about", i18nKey: "settings.catAbout" },
];

// ── Styles ──

// 样式见 ./settingsStyles（抽出供 ShortcutsPanel 等同级子页面复用）

// ── Form field helpers ──

function Label({ text }: { text: string }) {
  return <label style={S.label}>{text}</label>;
}

function FieldHint({ text }: { text: string }) {
  return <div style={{ fontSize: "calc(var(--font-scale, 1) * 11px)", color: "var(--fg-muted)", marginTop: 2 }}>{text}</div>;
}

function IntField({ value, onChange, min, max }: { value: number; onChange: (v: number) => void; min: number; max: number }) {
  return (
    <input type="number" min={min} max={max} value={value}
      onChange={(e) => onChange(parseInt(e.target.value, 10) || min)}
      style={{ ...S.input, width: 72 }} />
  );
}

/**
 * 外部链接行（关于页的仓库地址）。
 *
 * 打开方式沿用项目既有约定（见 FeedbackDialog）：Tauri `plugin-shell.open`，
 * 失败则回落 `window.open`。**两者都失败时把 URL 复制到剪贴板**并以
 * `title` 提示 —— 比静默无反应好：用户至少能手动粘贴。
 */
function RepoLink({ label, url }: { label: string; url: string }) {
  const [failed, setFailed] = useState(false);

  const handleOpen = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-shell");
      await open(url);
      setFailed(false);
    } catch {
      try {
        window.open(url, "_blank");
        setFailed(false);
      } catch {
        try { await navigator.clipboard.writeText(url); } catch { /* 剪贴板也不可用 */ }
        setFailed(true);
      }
    }
  };

  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 6, padding: "2px 0" }}>
      <span style={{ fontSize: "calc(var(--font-scale, 1) * 11px)", color: "var(--fg-muted)", flexShrink: 0 }}>
        {label}
      </span>
      <span
        onClick={handleOpen}
        title={failed ? t("settings.aboutOpenFailed") : url}
        style={{
          flex: 1, minWidth: 0,
          fontSize: "calc(var(--font-scale, 1) * 11px)",
          color: failed ? "var(--semantic-warning)" : "var(--accent)",
          cursor: "pointer",
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          textAlign: "left",
        }}
      >
        {url.replace(/^https?:\/\//, "")}
      </span>
    </div>
  );
}

/**
 * 设置分组卡片 —— 把「一组相关设置」圈成有边界的块。
 *
 * 用途：**一页里有多个独立来源/主题**时（插件页：每个插件各成一组；
 * 未来若有其他同类页面复用它）。单主题的扁平表单页不需要 —— 那些页的
 * 字段天然属于同一个上下文，加卡片反而是噪声。
 */
function SettingsCard({ title, meta, children }: {
  title: string;
  meta?: string;
  children: React.ReactNode;
}) {
  return (
    <div style={S.card}>
      <div style={S.cardTitle}>
        <span style={S.cardTitleText}>{title}</span>
        {meta && <span style={S.cardTitleMeta}>{meta}</span>}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>{children}</div>
    </div>
  );
}

function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

// ── 插件设置区（按插件分组渲染, VS Code 扩展设置页同款）──

function PluginSettingsPanel() {
  const [manifests, setManifests] = useState<PluginManifest[]>([]);
  const [scope, setScope] = useState<"global" | "workspace">("global");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { getInstalledPluginEntries, scanPlugins } = await import("../../services/pluginRegistry");
      const entries = await getInstalledPluginEntries();
      if (cancelled) return;
      // 只显示声明了 settings 的已装插件
      const withSettings = scanPlugins([...entries.values()].map((e) => ({ name: e.name, manifestJson: e.manifestJson! })))
        .filter((m) => Object.keys(m.settings ?? {}).length > 0);
      setManifests(withSettings);
    })();
    return () => { cancelled = true; };
  }, []);

  if (manifests.length === 0) {
    return <EmptyState text={t("settings.pluginsNone")} />;
  }

  return (
    // 每个插件是一张卡片，间距交给 S.form 的 gap（原来 gap:0 + borderBottom
    // 是靠下划线区分，插件多了像一整块表单）
    <div style={S.form}>
      <div style={{ ...S.row, justifyContent: "space-between" }}>
        <span style={{ fontSize: "calc(var(--font-scale, 1) * 11px)", color: "var(--fg-secondary)" }}>
          {t("settings.pluginsSaveScope")}
        </span>
        <div style={{ display: "flex", gap: 6 }}>
          <button onClick={() => setScope("global")} style={scopeBtnStyle(scope === "global")}>{t("settings.globalScope")}</button>
          <button onClick={() => setScope("workspace")} style={scopeBtnStyle(scope === "workspace")}>{t("settings.workspaceScope")}</button>
        </div>
      </div>
      {manifests.map((m) => (
        <PluginSettingsSection key={m.pluginName} manifest={m} scope={scope} />
      ))}
    </div>
  );
}

function PluginSettingsSection({ manifest, scope }: { manifest: PluginManifest; scope: "global" | "workspace" }) {
  const values = usePluginSettings(manifest.pluginName);

  const setValue = (key: string, v: string | number | boolean) => {
    void updatePluginSetting(manifest.pluginName, key, v, scope);
  };

  return (
    <SettingsCard
      title={manifest.displayName || manifest.pluginName}
      meta={`v${manifest.version}`}
    >
      {Object.entries(manifest.settings ?? {}).map(([id, def]) => (
        <div key={id}>
          <Label text={def.title} />
          {def.type === "boolean" && (
            <div style={{ marginTop: 2 }}>
              <Toggle value={Boolean(values[id] ?? def.default ?? false)} onChange={(v) => setValue(id, v)} />
            </div>
          )}
          {def.type === "string" && (
            <input type="text"
              value={String(values[id] ?? def.default ?? "")}
              onChange={(e) => setValue(id, e.target.value)}
              style={{ ...S.input, width: "100%", boxSizing: "border-box", marginTop: 2 }} />
          )}
          {def.type === "number" && (
            <input type="number"
              value={Number(values[id] ?? def.default ?? 0)}
              min={def.min} max={def.max}
              onChange={(e) => setValue(id, parseFloat(e.target.value) || 0)}
              style={{ ...S.input, width: 96, marginTop: 2 }} />
          )}
          {def.type === "select" && (
            <select
              value={String(values[id] ?? def.default ?? def.options?.[0]?.value ?? "")}
              onChange={(e) => setValue(id, e.target.value)}
              style={{ ...S.select, marginTop: 2 }}>
              {(def.options ?? []).map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          )}
          {def.description && <FieldHint text={def.description} />}
        </div>
      ))}
    </SettingsCard>
  );
}

// ── 压缩配置区（chat 分类）──

function CompactSettingsSection({ settings, update }: {
  settings: AppSettings;
  update: (patch: Partial<AppSettings>) => void;
}) {
  const ccp = settings.customCompactPrompt;
  const mode = ccp?.mode ?? "append";
  const text = ccp?.text ?? "";
  const enabled = text.trim() !== "";
  // 预设识别靠 presetId；缺省（旧设置无 presetId）按 text 推导，兼容历史配置
  const derivePreset = (): "none" | "handoff" | "custom" =>
    ccp?.presetId ?? (!text.trim() ? "none" : text === HANDOFF_COMPACT_PRESET ? "handoff" : "custom");
  const preset = derivePreset();

  const patchPrompt = (p: {
    mode?: "append" | "replace";
    text?: string;
    presetId?: "none" | "handoff" | "custom";
  }) =>
    update({
      customCompactPrompt: {
        mode: p.mode ?? mode,
        text: p.text ?? text,
        presetId: p.presetId ?? ccp?.presetId,
      },
    });

  // 迁移：识别为 handoff 但 text 不是最新模板 → 自动刷新为最新（改预设模板后旧设置跟上）
  useEffect(() => {
    if (derivePreset() === "handoff" && text !== HANDOFF_COMPACT_PRESET) {
      update({ customCompactPrompt: { mode, text: HANDOFF_COMPACT_PRESET, presetId: "handoff" } });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div style={{ borderTop: "1px solid var(--border-light)", paddingTop: 12 }}>
      <Label text={t("settings.customCompactPrompt")} />
      <div style={S.row}>
        <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
          <input type="checkbox" checked={enabled}
            onChange={(e) => patchPrompt({
              text: e.target.checked ? (text || HANDOFF_COMPACT_PRESET) : "",
              presetId: e.target.checked ? (ccp?.presetId ?? "handoff") : "none",
            })} />
          <span>{t("settings.customCompactEnabled")}</span>
        </label>
      </div>
      {enabled && (
        <>
          <div style={S.row}>
            <select value={mode}
              onChange={(e) => patchPrompt({ mode: e.target.value as "append" | "replace" })}
              style={S.select}>
              <option value="append">{t("settings.customCompactModeAppend")}</option>
              <option value="replace">{t("settings.customCompactModeReplace")}</option>
            </select>
            <select value={preset}
              onChange={(e) => patchPrompt({
                text: e.target.value === "handoff" ? HANDOFF_COMPACT_PRESET : e.target.value === "none" ? "" : text,
                presetId: e.target.value as "none" | "handoff" | "custom",
              })}
              style={S.select}>
              <option value="none">{t("settings.customCompactPresetNone")}</option>
              <option value="custom">{t("settings.customCompactPresetCustom")}</option>
              <option value="handoff">{t("settings.customCompactPresetHandoff")}</option>
            </select>
          </div>
          <textarea value={text}
            onChange={(e) => patchPrompt({ text: e.target.value, presetId: "custom" })}
            style={{ width: "100%", minHeight: 90, border: "1px solid var(--border-medium)", borderRadius: 4, padding: 6, fontFamily: "inherit", fontSize: 12, background: "var(--bg-root)" }} />
          <FieldHint text={t("settings.customCompactPromptDesc")} />
        </>
      )}
      <div style={{ marginTop: 8 }}>
        <Label text={t("settings.compactExtractScript")} />
        <input value={settings.compactExtractScript ?? ""} placeholder={DEFAULT_EXTRACT_SCRIPT}
          onChange={(e) => update({ compactExtractScript: e.target.value })}
          style={{ ...S.input, width: "100%" }} />
        <FieldHint text={t("settings.compactExtractScriptDesc")} />
      </div>
      <div style={{ marginTop: 8 }}>
        <Label text={t("settings.streamStallWakePrompt")} />
        <input value={settings.streamStallWakePrompt ?? ""} placeholder={DEFAULT_STALL_WAKE_PROMPT}
          onChange={(e) => update({ streamStallWakePrompt: e.target.value })}
          style={{ ...S.input, width: "100%" }} />
        <FieldHint text={t("settings.streamStallWakePromptDesc")} />
      </div>
    </div>
  );
}

// ── Content renderer per category ──

function CategoryContent({ cat, settings, update, flashField }: {
  cat: string;
  settings: AppSettings;
  update: (patch: Partial<AppSettings>) => void;
  flashField: string | null;
}) {
  switch (cat) {
    case "general":
      return (
        <div style={S.form}>
          <div>
            <Label text={t("settings.language")} />
            <select
              value={settings.language}
              onChange={(e) => {
                const lang = e.target.value as Language;
                update({ language: lang });
                setLanguage(lang);
              }}
              style={S.select}
            >
              <option value="zh">{t("wizard.langZh")}</option>
              <option value="en">English</option>
            </select>
            <FieldHint text={t("settings.languageDesc")} />
          </div>
          <div>
            <Label text={t("settings.theme")} />
            <select
              value={settings.theme ?? "light"}
              onChange={(e) => {
                const theme = e.target.value;
                document.documentElement.dataset.theme = theme;
                update({ theme });
              }}
              style={S.select}
            >
              <option value="light">{t("settings.themeLight")}</option>
              <option value="dark">{t("settings.themeDark")}</option>
              <option value="dark-a">{t("settings.themeDarkA")}</option>
              <option value="dark-b">{t("settings.themeDarkB")}</option>
            </select>
            <FieldHint text={t("settings.themeDesc")} />
          </div>
          <div>
            <Label text={t("settings.uiFontSize")} />
            <FontSizeSlider settings={settings} update={update} />
            <FieldHint text={t("settings.uiFontSizeDesc")} />
          </div>
          <div>
            <Label text={t("settings.autoEnterRecentWorkspace")} />
            <Toggle value={settings.autoEnterRecentWorkspace ?? false}
              onChange={(v) => update({ autoEnterRecentWorkspace: v })} />
            <FieldHint text={t("settings.autoEnterRecentWorkspaceDesc")} />
          </div>
          <div>
            <Label text={t("settings.saveLayoutToGlobal")} />
            <Toggle value={settings.saveLayoutToGlobal ?? false}
              onChange={(v) => update({ saveLayoutToGlobal: v })} />
            <FieldHint text={t("settings.saveLayoutToGlobalDesc")} />
          </div>
          <div>
            <Label text={t("settings.serverAddr")} />
            <input type="text"
              value={settings.skillRegistryUrl ?? "http://192.168.186.96:8765"}
              onChange={(e) => update({ skillRegistryUrl: e.target.value })}
              style={{ ...S.input, width: "100%", boxSizing: "border-box" }} />
            <FieldHint text={t("settings.serverAddrDesc")} />
          </div>
        </div>
      );

    case "skills":
      return (
        <div style={S.form} />
      );

    case "shortcuts":
      return (
        <ShortcutsPanel
          overrides={settings.shortcuts}
          onChange={(next) => {
            // 改键**立即持久化**（不像其他字段等"保存"按钮）——
            //  · 快捷键是明确的单次操作，用户按完就该生效并留存
            //  · 若只写内存，用户不点保存就重启会丢失
            //  · 范围固定 global：后端 AppSettings 无工作区级 shortcuts
            void saveSettings({ shortcuts: next }, "global").catch(() => {});
            update({ shortcuts: next });
          }}
        />
      );

    case "files":
      return (
        <div style={S.form}>
          <div>
            <Label text={t("settings.showHiddenFiles")} />
            <Toggle value={settings.showHiddenFiles ?? false}
              onChange={(v) => update({ showHiddenFiles: v })} />
            <FieldHint text={t("settings.showHiddenFilesDesc")} />
          </div>
          <div>
            <Label text={t("settings.fileSortOrder")} />
            <select value={settings.fileSortOrder ?? "name"}
              onChange={(e) => update({ fileSortOrder: e.target.value as "name" | "date" | "type" })}
              style={S.select}>
              <option value="name">{t("settings.fileSortName")}</option>
              <option value="date">{t("settings.fileSortDate")}</option>
              <option value="type">{t("settings.fileSortType")}</option>
            </select>
            <FieldHint text={t("settings.fileSortOrderDesc")} />
          </div>
        </div>
      );

    case "terminal":
      return (
        <div style={S.form}>
          <div>
            <Label text={t("settings.terminalMaxEntries")} />
            <IntField value={settings.terminalMaxEntries ?? 50}
              onChange={(v) => update({ terminalMaxEntries: v })} min={5} max={500} />
            <FieldHint text={t("settings.terminalMaxEntriesDesc")} />
          </div>
          <div>
            <Label text={t("settings.terminalFontSize")} />
            <IntField value={settings.terminalFontSize ?? 13}
              onChange={(v) => update({ terminalFontSize: v })} min={10} max={24} />
            <FieldHint text={t("settings.terminalFontSizeDesc")} />
          </div>
        </div>
      );

    case "editor":
      return (
        <div style={S.form}>
          <div>
            <Label text={t("settings.editorFontSize")} />
            <IntField value={settings.editorFontSize ?? 14}
              onChange={(v) => update({ editorFontSize: v })} min={10} max={24} />
            <FieldHint text={t("settings.editorFontSizeDesc")} />
          </div>
          <div>
            <Label text={t("settings.editorTabSize")} />
            <select value={settings.editorTabSize ?? 4}
              onChange={(e) => update({ editorTabSize: parseInt(e.target.value, 10) })}
              style={{ ...S.select, width: 72 }}>
              <option value={2}>2</option>
              <option value={4}>4</option>
              <option value={8}>8</option>
            </select>
            <FieldHint text={t("settings.editorTabSizeDesc")} />
          </div>
          <div>
            <Label text={t("settings.editorWordWrap")} />
            <Toggle value={settings.editorWordWrap ?? false}
              onChange={(v) => update({ editorWordWrap: v })} />
            <FieldHint text={t("settings.editorWordWrapDesc")} />
          </div>
        </div>
      );

    case "chat":
      return (
        <div style={S.form}>
          <div>
            <Label text={t("settings.chatEnterBehavior")} />
            <select value={settings.chatEnterBehavior ?? "send"}
              onChange={(e) => update({ chatEnterBehavior: e.target.value as "send" | "newline" })}
              style={S.select}>
              <option value="send">{t("settings.chatEnterSend")} — {t("settings.chatEnterSendDesc")}</option>
              <option value="newline">{t("settings.chatEnterNewline")} — {t("settings.chatEnterNewlineDesc")}</option>
            </select>
            <FieldHint text={t("settings.chatEnterBehaviorDesc")} />
          </div>
          <div>
            <Label text={t("settings.autoLoadLatestSession")} />
            <Toggle value={settings.autoLoadLatestSession ?? true}
              onChange={(v) => update({ autoLoadLatestSession: v })} />
            <FieldHint text={t("settings.autoLoadLatestSessionDesc")} />
          </div>
          <div>
            <Label text={t("settings.forceChineseThinking")} />
            <Toggle value={settings.forceChineseThinking ?? false}
              onChange={(v) => update({ forceChineseThinking: v })} />
            <FieldHint text={t("settings.forceChineseThinkingDesc")} />
          </div>
          <div>
            <Label text={t("settings.msgQueuePosition")} />
            <select value={settings.msgQueuePosition ?? "top"}
              onChange={(e) => update({ msgQueuePosition: e.target.value as "top" | "right" })}
              style={S.select}>
              <option value="top">{t("settings.msgQueuePosTop")}</option>
              <option value="right">{t("settings.msgQueuePosRight")}</option>
            </select>
            <FieldHint text={t("settings.msgQueuePositionDesc")} />
          </div>
          <div>
            <Label text={t("settings.msgQueueMaxItems")} />
            <IntField value={settings.msgQueueMaxItems ?? 20} min={1} max={50}
              onChange={(v) => update({ msgQueueMaxItems: v })} />
            <FieldHint text={t("settings.msgQueueMaxItemsDesc")} />
          </div>
          <div>
            <Label text={t("settings.msgSelectionToolbar")} />
            <Toggle value={settings.msgSelectionToolbar ?? true}
              onChange={(v) => update({ msgSelectionToolbar: v })} />
            <FieldHint text={t("settings.msgSelectionToolbarDesc")} />
          </div>
          <div>
            <Label text={t("settings.messageTimeline")} />
            <Toggle value={settings.messageTimeline ?? true}
              onChange={(v) => update({ messageTimeline: v })} />
            <FieldHint text={t("settings.messageTimelineDesc")} />
          </div>
          <div data-setting-field="contextWarningEnabled"
            style={{ ...S.fieldFlash(flashField === "contextWarningEnabled") }}>
            <Label text={t("settings.contextWarning")} />
            <Toggle value={settings.contextWarningEnabled ?? DEFAULT_CONTEXT_WARNING_ENABLED}
              onChange={(v) => update({ contextWarningEnabled: v })} />
            <FieldHint text={t("settings.contextWarningDesc")} />
          </div>
          <div data-setting-field="contextWarningPercent"
            style={{ ...S.fieldFlash(flashField === "contextWarningPercent") }}>
            <Label text={t("settings.contextWarningPercent")} />
            <IntField value={settings.contextWarningPercent ?? DEFAULT_CONTEXT_WARNING_PERCENT} min={50} max={99}
              onChange={(v) => update({ contextWarningPercent: v })} />
            <FieldHint text={t("settings.contextWarningPercentDesc")} />
          </div>
          <CompactSettingsSection settings={settings} update={update} />
        </div>
      );

    case "sessions":
      return (
        <div style={S.form}>
          <div>
            <Label text={t("settings.sessionFolders")} />
            <Toggle value={settings.sessionFolders ?? false}
              onChange={(v) => update({ sessionFolders: v })} />
            <FieldHint text={t("settings.sessionFoldersDesc")} />
          </div>
        </div>
      );

    case "about":
      return (
        <div style={{ ...S.form, alignItems: "center", textAlign: "center", paddingTop: 32 }}>
          <div style={{ fontSize: "calc(var(--font-scale, 1) * 24px)", fontWeight: 700, color: "var(--fg-primary)", marginBottom: 4 }}>
            Claude Code
          </div>
          <div style={{ fontSize: "calc(var(--font-scale, 1) * 14px)", color: "var(--fg-muted)", marginBottom: 16 }}>
            v{settings._version ?? "1.0.0-preview"}
          </div>
          <div style={{ fontSize: "calc(var(--font-scale, 1) * 12px)", color: "var(--fg-secondary)", lineHeight: 1.8, maxWidth: 320 }}>
            {t("settings.aboutDescription")}
          </div>

          {/* 源码仓库 —— gitee 是主仓库（日常 push 目标），github 是只读镜像
              （github-clean 快照分支，见 scripts/sync-github-clean.sh）。 */}
          <div style={{ marginTop: 20, width: "100%", maxWidth: 320 }}>
            <div style={{ fontSize: "calc(var(--font-scale, 1) * 11px)", color: "var(--fg-muted)", marginBottom: 6 }}>
              {t("settings.aboutRepos")}
            </div>
            <RepoLink label={t("settings.aboutRepoGitee")} url="https://gitee.com/randomlife/claude-code-haha-dev" />
            <RepoLink label={t("settings.aboutRepoGithub")} url="https://github.com/o2bubble/claude-code-haha-rush" />
          </div>

          <div style={{ fontSize: "calc(var(--font-scale, 1) * 11px)", color: "var(--fg-muted)", marginTop: 20 }}>
            {t("settings.aboutTechStack")}
          </div>
        </div>
      );

    case "desktop":
      return <EmptyState text={t("settings.empty")} />;

    case "plugins":
      return <PluginSettingsPanel />;

    default:
      return null;
  }
}

// ── Font size slider (local state, applies on release) ──

function FontSizeSlider({ settings, update }: {
  settings: AppSettings;
  update: (patch: Partial<AppSettings>) => void;
}) {
  const [val, setVal] = useState(settings.uiFontSize ?? 100);
  const extVal = settings.uiFontSize ?? 100;

  useEffect(() => { setVal(extVal); }, [extVal]);

  const handleApply = useCallback(() => update({ uiFontSize: val }), [val, update]);

  return (
    <div style={{ ...S.row, alignItems: "center", gap: 8 }}>
      <input type="range" min={70} max={150} step={10}
        value={val}
        onChange={(e) => setVal(parseInt(e.target.value, 10))}
        onMouseUp={handleApply}
        onTouchEnd={handleApply}
        style={{ width: 120 }} />
      <span style={{ fontSize: "calc(var(--font-scale, 1) * 12px)", minWidth: 36, color: "var(--fg-primary)" }}>{val}%</span>
    </div>
  );
}

function scopeBtnStyle(active: boolean): React.CSSProperties {
  return {
    border: active ? "1px solid var(--accent)" : "1px solid var(--border-medium)",
    borderRadius: 4,
    padding: "3px 8px",
    cursor: "pointer",
    fontSize: "calc(var(--font-scale, 1) * 11px)",
    fontFamily: "inherit",
    backgroundColor: active ? "var(--accent-subtle)" : "var(--bg-root)",
    color: active ? "var(--accent)" : "var(--fg-secondary)",
    fontWeight: active ? 600 : 400,
  };
}

// ── Main component ──

function SettingsPanelImpl() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [cat, setCat] = useState("general");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const [flashField, setFlashField] = useState<string | null>(null);
  // Save target scope: global baseline vs the bound workspace's local overrides.
  const [scope, setScope] = useState<"global" | "workspace">("global");
  // Fields changed since the last save — only these are written to the target file,
  // so a workspace-scoped save doesn't shadow every global field.
  const [dirty, setDirty] = useState<Partial<AppSettings>>({});

  useEffect(() => {
    loadSettings().then((s) => {
      setSettings({ ...s });
      setLanguage(s.language || "zh");
    });
  }, []);

  // Sync external changes when user hasn't made unsaved edits
  useEventHandler<{ settings: AppSettings }>(Events.SETTINGS_CHANGED, (data) => {
    if (saving) return;
    setSettings({ ...data.settings });
  });

  // ── 命令面板/「去设置」导航：跳转到指定分类，并可选定位高亮具体字段 ──
  useEffect(() => {
    return crossWindowBus.subscribe("settings.navigate", (payload) => {
      const p = payload as { category?: string; field?: string } | null;
      if (p?.category && CATEGORIES.some((c) => c.id === p.category)) {
        setCat(p.category);
      }
      if (p?.field) {
        setFlashField(p.field);
      }
    });
  }, []);

  // flashField 变化后（分类已切换、DOM 已渲染）滚动到目标字段；高亮保持 ~1.8s
  useEffect(() => {
    if (!flashField) return;
    const t1 = setTimeout(() => {
      contentRef.current?.querySelector(`[data-setting-field="${flashField}"]`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 80);
    const t2 = setTimeout(() => setFlashField(null), 1800);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [flashField]);

  if (!settings) return null;

  const update = (patch: Partial<AppSettings>) => {
    setSettings((s) => (s ? { ...s, ...patch } : s));
    setDirty((d) => ({ ...d, ...patch }));
    updateSettings(patch);
  };

  const handleSave = async () => {
    if (!settings) return;
    setSaving(true);
    await saveSettings({ ...dirty, isFirstLaunch: false }, scope);
    setDirty({});
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div style={S.container}>
      {/* Left sidebar — category nav */}
      <div style={S.sidebar}>
        {CATEGORIES.map((c) => (
          <div key={c.id}
            onClick={() => setCat(c.id)}
            style={S.navBtn(cat === c.id)}>
            {t(c.i18nKey)}
          </div>
        ))}
      </div>

      {/* Right content */}
      <div style={S.content}>
        <div style={S.header}>
          {t("settings.title")}
        </div>

        <div ref={contentRef} style={{ flex: 1, overflow: "auto" }}>
          <CategoryContent cat={cat} settings={settings} update={update} flashField={flashField} />
        </div>

        <div style={S.saveBar}>
          <div style={{ display: "flex", gap: 4, alignItems: "center", marginRight: "auto" }}>
            <span style={{ fontSize: "calc(var(--font-scale, 1) * 11px)", color: "var(--fg-muted)", marginRight: 6 }}>
              {t("settings.scopeLabel")}
            </span>
            <button onClick={() => setScope("global")} style={scopeBtnStyle(scope === "global")}>
              {t("settings.scopeGlobal")}
            </button>
            {/* 快捷键仅支持全局范围 —— 后端 AppSettings 没有该字段、工作区合并也不含它，
                选"工作区"会静默丢弃改键。这里直接禁用并用 title 说明原因。 */}
            <button
              onClick={() => { if (cat !== "shortcuts") setScope("workspace"); }}
              disabled={cat === "shortcuts"}
              title={cat === "shortcuts" ? t("settings.shortcutsGlobalOnly") : undefined}
              style={{
                ...scopeBtnStyle(cat === "shortcuts" ? false : scope === "workspace"),
                ...(cat === "shortcuts" ? { opacity: 0.4, cursor: "not-allowed" } : {}),
              }}
            >
              {t("settings.scopeWorkspace")}
            </button>
          </div>
          <button onClick={handleSave} disabled={saving} style={S.saveBtn(saved ? "var(--semantic-success)" : "var(--accent)")}>
            {saving ? t("settings.saving") : saved ? t("settings.saved") : t("settings.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
export const SettingsPanel = memo(SettingsPanelImpl);
