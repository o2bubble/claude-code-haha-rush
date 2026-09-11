// 编辑器正文 / 标签右键共用："定位目录树" 或 fallback 到资源管理器。
// 文件在当前工作区 → 文件树展开祖先并选中(事件 FILE_REVEAL + 激活 files 面板)；
// 不在工作区 → 打开系统资源管理器并提示(目录树定位找不到区外文件)。
//
// 路径归一化是本功能的生命线——agent 的 ref chip 路径姿势不可控：
// 盘符大小写(c:\ vs C:\)、正反斜杠、甚至工作区内相对路径(src/foo.ts)。
// Windows/NTFS 大小写不敏感，比较必须同样不敏感(统一 lowercase)，
// 否则 startsWith 误判"区外" → 定位无反应(用户实测)。

import { windowBus } from "../services/windowBus";
import { Events } from "../services/events";
import { getSettings } from "../stores/settingsStore";
import { activatePanel } from "../stores/layoutStore";
import { addStatusMessage } from "../stores/statusMsgStore";
import { t } from "../i18n";

/** 归一化路径用于比较: 反斜杠→正斜杠, 去尾分隔符, Windows 语义下转小写。 */
function normPath(p: string): string {
  let s = (p ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
  if (s.match(/^[a-z]:/i)) s = s.toLowerCase();
  return s;
}

/** 解析 agent 给的路径为可定位的绝对路径。相对路径(无盘符且不以 / 开头)拼工作区。 */
function resolveAgainstWorkspace(path: string, ws: string): string {
  if (/^[a-z]:[\\/]/i.test(path) || path.startsWith("/")) return path;
  if (!ws) return path;
  const sep = ws.includes("\\") ? "\\" : "/";
  return `${ws.replace(/\/+$/, "")}${sep}${path.replace(/^[./\\]+/, "")}`;
}

/** 每次 reveal 递增 —— 消费方（FileTree）用它区分"新请求"，使对同一文件的
 *  再次定位也能重新滚动（path 不变时 React 的依赖比较无法感知新请求）。 */
let revealNonce = 0;

export function revealFileInTree(rawPath: string) {
  if (!rawPath) return;
  const settings = getSettings();
  const wsRaw = settings.workDir ?? "";
  const ws = normPath(wsRaw);

  // 相对路径先拼工作区（agent ref chip 常见姿势）
  const candidate = resolveAgainstWorkspace(rawPath, wsRaw);
  const fp = normPath(candidate);

  const inWorkspace = !!ws && fp !== ws && (fp.startsWith(ws + "/") || fp === normPath(wsRaw));
  if (inWorkspace) {
    // 先激活 files 面板(未开则开)再发事件。sticky 保留给尚未挂载的面板 replay
    // (React 挂载是异步的, 立即 clear 会丢事件)——消费方收到后自行 clear。
    activatePanel("files");
    windowBus.emit(
      Events.FILE_REVEAL,
      { path: candidate, rootPath: wsRaw, nonce: ++revealNonce },
      { sticky: true },
    );
  } else {
    import("@tauri-apps/api/core").then(({ invoke }) =>
      invoke("open_in_explorer", { path: candidate }).catch(() => {}));
    addStatusMessage(t("editor.revealExplorerHint"), "info");
  }
}
