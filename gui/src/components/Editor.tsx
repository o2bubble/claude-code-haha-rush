import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { t } from "../i18n";
import Editor, { type OnMount, loader } from "@monaco-editor/react";
import { detectLanguageForMonaco } from "../utils/detectLanguage";
import { isDarkTheme } from "../utils/themeUtils";
import { fileService } from "../services/fileService";
import { editorStore } from "../stores/editorStore";
import { getSettings } from "../stores/settingsStore";
import { useEvent } from "../services/useService";
import { Events, type SettingsChangedPayload } from "../services/events";
import { eventBus } from "../services/serviceBus";
import { setActiveEditor } from "../utils/editorCommands";
import { revealFileInTree } from "../utils/revealFile";

// Lazy-configure Monaco to use local files instead of CDN
let monacoReady = false;
async function ensureMonaco() {
  if (monacoReady) return;

  // Dynamic base path — works with every protocol (http://, tauri://, https://tauri.localhost)
  const baseUrl = window.location.origin + "/monaco/vs";

  // Worker creator — uses fetch+blob to bypass protocol issues in Tauri production
  const workerUrls: Record<string, string> = {
    typescript: baseUrl + "/language/typescript/ts.worker.js",
    javascript: baseUrl + "/language/typescript/ts.worker.js",
    json: baseUrl + "/language/json/json.worker.js",
    css: baseUrl + "/language/css/css.worker.js",
    scss: baseUrl + "/language/css/css.worker.js",
    less: baseUrl + "/language/css/css.worker.js",
    html: baseUrl + "/language/html/html.worker.js",
    handlebars: baseUrl + "/language/html/html.worker.js",
    razor: baseUrl + "/language/html/html.worker.js",
  };
  const defaultWorkerUrl = baseUrl + "/editor/editor.worker.js";

  (self as any).MonacoEnvironment = {
    getWorker(_workerId: string, label: string) {
      const url = workerUrls[label] || defaultWorkerUrl;
      // Fetch worker script then create a same-origin Worker from a blob URL
      return fetch(url)
        .then((r) => r.text())
        .then((js) => new Worker(URL.createObjectURL(new Blob([js], { type: "application/javascript" }))));
    },
  };

  // ── Monaco nls 国际化 ──
  // 不能通过 loader.config 的 "vs/nls" 走 AMD 插件：语言包 zh-cn.js 是普通脚本
  // （设置 globalThis._VSCODE_NLS_MESSAGES），非 AMD define，AMD loader 加载它会
  // 一直等待 define 不返回 → editor.main 挂起 → 编辑器卡在 Loading。
  // 正确做法：在 Monaco 加载前手动 fetch + eval 语言包，nls.js 的 getNLSMessages()
  // 会直接读 globalThis._VSCODE_NLS_MESSAGES。
  const lang = getSettings().language ?? "zh";
  if (lang.startsWith("zh")) {
    try {
      const resp = await fetch(baseUrl + "/nls/lang/zh-cn.js");
      const js = await resp.text();
      (0, eval)(js); // 语言包内容：globalThis._VSCODE_NLS_MESSAGES=[...]
      (globalThis as any)._VSCODE_NLS_LANGUAGE = "zh-cn";
    } catch { /* 语言包加载失败则保持英文 */ }
  }

  loader.config({ paths: { vs: baseUrl } });
  monacoReady = true;
}

interface EditorProps {
  path: string;
  name: string;
  content: string;
  onChange: (content: string) => void;
  readOnly?: boolean;
}

export default memo(function MonacoEditor({ path, name, content, onChange, readOnly }: EditorProps) {
  const [ready, setReady] = useState(monacoReady);
  const [isDark, setIsDark] = useState(
    () => typeof document !== "undefined" && isDarkTheme(document.documentElement.dataset.theme)
  );

  useEffect(() => {
    ensureMonaco().then(() => setReady(true));
    // Watch for theme changes
    const obs = new MutationObserver(() => {
      setIsDark(isDarkTheme(document.documentElement.dataset.theme));
    });
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => obs.disconnect();
  }, []);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const pathRef = useRef(path);
  pathRef.current = path;

  // 卸载时清除活动编辑器引用，避免命令面板读到已销毁实例
  useEffect(() => () => { setActiveEditor(null); }, []);

  const sp = useEvent<SettingsChangedPayload>(Events.SETTINGS_CHANGED);
  const s = sp?.settings ?? getSettings();

  // options 对象用 useMemo 稳定身份——否则父组件每次重渲染都新建对象,
  // 打爆 @monaco-editor/react <Editor>(memo) 的 memo, 导致本不该发生的子重渲染
  // (进而推高 #300/#310 瞬时 hydration 竞态概率)。
  const editorOptions = useMemo<import("monaco-editor").editor.IStandaloneEditorConstructionOptions>(() => ({
    minimap: { enabled: true },
    fontSize: s.editorFontSize ?? 14,
    lineNumbers: "on",
    tabSize: s.editorTabSize ?? 4,
    wordWrap: s.editorWordWrap ? "on" : "off",
    scrollBeyondLastLine: false,
    automaticLayout: true,
    readOnly: readOnly ?? false,
  }), [s.editorFontSize, s.editorTabSize, s.editorWordWrap, readOnly]);

  const handleMount: OnMount = (editor, monaco) => {
    // 注册活动编辑器实例供命令面板读取 getSupportedActions
    setActiveEditor(editor);

    // ── 覆盖 F1 / Ctrl+Shift+P → 打开统一命令面板 ──
    // Monaco 默认 F1 弹出编辑器原生命令面板；这里重定向到应用统一面板，
    // 焦点在编辑器内时编辑器命令置顶。Ctrl+Shift+P 同理。
    editor.addCommand(monaco.KeyCode.F1, () => {
      eventBus.emit(Events.COMMAND_PALETTE_OPEN, { context: "editor" });
    });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyP, () => {
      eventBus.emit(Events.COMMAND_PALETTE_OPEN, { context: "editor" });
    });

    // ── 覆盖右键菜单 "命令面板" 入口 → 打开统一面板 ──
    // context menu 的 Command Palette 条目执行 editor.action.quickCommand，
    // 这里把该命令重定向到我们的面板（nls 后 label 已显示为中文）。
    monaco.editor.registerCommand("editor.action.quickCommand", () => {
      eventBus.emit(Events.COMMAND_PALETTE_OPEN, { context: "editor" });
    });

    if (!readOnly) {
      editor.addAction({
        id: "save-file",
        label: t("editor.saveFile"),
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
        run: async () => {
          try {
            const content = editor.getValue();
            await fileService.saveFile(pathRef.current, content);
            editorStore.setContent(pathRef.current, content);
            editorStore.markClean(pathRef.current);
          } catch (e) {
            console.error("Save failed:", e);
          }
        },
      });
    }

    // ── Send selection to chat ──
    // ── Send to chat via @ref{file:path:line} ──
    editor.addAction({
      id: "send-line-to-chat",
      label: t("files.sendToChat"),
      contextMenuGroupId: "9_cutcopypaste",
      contextMenuOrder: 2.5,
      run: () => {
        const sel = editor.getSelection();
        const start = sel?.startLineNumber || editor.getPosition()?.lineNumber || 1;
        const end = sel && !sel.isEmpty() && sel.endLineNumber !== start ? sel.endLineNumber : undefined;
        eventBus.emit("chat.addReference", {
          reference: { type: "file", path: pathRef.current, startLine: start, endLine: end },
        });
      },
    });

    // ── 定位目录树 / 在资源管理器中打开 ──
    // 当前打开文件在**本工作区**内 → 在文件树中定位(展开祖先+选中)；不在工作区
    // → fallback 到"在资源管理器中打开"(目录树定位找不到区外的文件)。
    editor.addAction({
      id: "reveal-in-file-tree",
      label: t("editor.revealInTree"),
      contextMenuGroupId: "9_cutcopypaste",
      contextMenuOrder: 2.6,
      run: () => {
        revealFileInTree(pathRef.current);
      },
    });
  };

  const handleChange = useCallback(
    (value: string | undefined) => {
      if (readOnly) return;
      onChangeRef.current(value ?? "");
    },
    [readOnly],
  );

  if (!ready) {
    return (
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "center",
        height: "100%", color: "var(--fg-muted)", fontSize: 13,
        fontFamily: "var(--font-sans)",
      }}>
        Loading editor...
      </div>
    );
  }

  return (
    <Editor
      height="100%"
      path={path}
      language={detectLanguageForMonaco(name)}
      value={content}
      theme={isDark ? "vs-dark" : "vs"}
      onMount={handleMount}
      onChange={readOnly ? undefined : handleChange}
      options={editorOptions}
    />
  );
});
