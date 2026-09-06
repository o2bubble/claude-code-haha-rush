// 编辑器正文 / 标签右键共用："定位目录树" 或 fallback 到资源管理器。
// 文件在当前工作区 → 文件树展开祖先并选中(事件 FILE_REVEAL + 激活 files 面板)；
// 不在工作区 → 打开系统资源管理器并提示(目录树定位找不到区外文件)。

import { windowBus } from "../services/windowBus";
import { Events } from "../services/events";
import { getSettings } from "../stores/settingsStore";
import { activatePanel } from "../stores/layoutStore";
import { addStatusMessage } from "../stores/statusMsgStore";
import { t } from "../i18n";

export function revealFileInTree(path: string) {
  if (!path) return;
  const ws = (getSettings().workDir ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
  const fp = path.replace(/\\/g, "/");
  const inWorkspace = !!ws && fp !== ws && fp.startsWith(ws + "/");
  if (inWorkspace) {
    windowBus.emit(Events.FILE_REVEAL, { path, rootPath: ws }, { sticky: true });
    activatePanel("files");
  } else {
    import("@tauri-apps/api/core").then(({ invoke }) =>
      invoke("open_in_explorer", { path }).catch(() => {}));
    addStatusMessage(t("editor.revealExplorerHint"), "info");
  }
}
