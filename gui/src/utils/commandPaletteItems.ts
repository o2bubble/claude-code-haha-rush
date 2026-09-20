// ── CommandPalette item 组装 — 从 store 数据构建 PaletteItem（纯函数，可单测）──

import type { PaletteItem } from "./commandPaletteLogic";
import { folderPathLabel, type SessionFolderTree } from "../components/chat/sessionFolders";

export interface PanelLike {
  id: string;
  title: string;
  icon?: string;
  userManaged?: boolean;
}

export interface CommandLike {
  cmd: string;
  desc: string;
  type: string;
}

export interface SessionLike {
  id: string;
  title: string;
  timestamp: number;
  isActive?: boolean;
}

/** 面板组：只保留用户可管理面板（userManaged !== false），标注已打开 */
export function buildPanelItems(panels: PanelLike[], isOpen: (panelId: string) => boolean): PaletteItem[] {
  return panels
    .filter((p) => p.userManaged !== false)
    .map((p) => ({
      id: `panel-${p.id}`,
      kind: "panel" as const,
      label: p.title,
      icon: p.icon,
      active: isOpen(p.id),
      run: () => {},
    }));
}

/** 技能翻译 map（SkillsPanel 同源）：cmd（可能带/）→ { title, desc } */
export type SkillI18n = Record<string, { title?: string; desc?: string }>;

/** 取技能的已翻译描述：兼容 cmd 带/不带/ 两种 key；无翻译回退原文 */
function translatedDesc(cmd: string, desc: string, i18n?: SkillI18n): string {
  if (!i18n) return desc;
  const tx = i18n[cmd] || i18n["/" + cmd];
  return tx?.desc || desc;
}

/** AI 命令组：插入输入框（不发送）。cmd 缺失的条目跳过，避免重复 key。
 *  desc 复用技能面板的国际化翻译（匹配上翻译后的 desc，否则保持原文）。 */
export function buildCommandItems(commands: CommandLike[], i18n?: SkillI18n): PaletteItem[] {
  return commands
    .filter((c) => c && c.cmd)
    .map((c) => ({
      id: `cmd-${c.cmd}`,
      kind: "command" as const,
      label: c.cmd,
      sublabel: translatedDesc(c.cmd, c.desc, i18n),
      icon: "quickPrompts",
      run: () => {},
    }));
}

/** 会话组：标注当前会话，按时间倒序 */
export function buildSessionItems(
  sessions: SessionLike[],
  activeSessionId: string | null,
  /** 会话文件夹树 —— 传入时，有归属的会话在名称**前面**显示层级路径 */
  folderTree?: SessionFolderTree,
): PaletteItem[] {
  return [...sessions]
    .sort((a, b) => b.timestamp - a.timestamp)
    .map((s) => {
      const path = folderTree ? folderPathLabel(folderTree, s.id) : "";
      return {
        id: `session-${s.id}`,
        kind: "session" as const,
        label: s.title || s.id,
        // 层级前缀（无归属时为空串 → 渲染层自然不显示）
        prefix: path || undefined,
        sublabel: new Date(s.timestamp).toLocaleString(),
        icon: "sessions",
        active: s.isActive || s.id === activeSessionId,
        run: () => {},
      };
    });
}
