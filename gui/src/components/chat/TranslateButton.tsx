// ── 消息块上的「翻译」按钮 ──
//
// 场景（2026-09-21 用户反馈）：英文内容看不懂，要能就地翻译，别逼用户开别的工具。
//
// 走的是后端的**旁问**通道（它本来就是 `/btw` 的实现）—— 在**同一个后端进程**里
// fork 一个轻量 agent 回答，不新起 claude 实例、不打断主对话。见 chatSession.askSideQuestion
// 与 ideMode 的 handleSideQuestion（后端注释里写着 "translation doesn't need full context"，
// 这个通道就是为翻译准备的）。
//
// 译文**内联展开在原文下方**（而不是弹窗）：翻译的目的就是对照着看，弹出去了反而
// 要来回切。按钮可再点一次收起。

import React, { useCallback, useState } from "react";
import { Languages, X } from "lucide-react";
import { chatSession } from "../../chat/chatSession";
import { getLanguage, t } from "../../i18n";

type Phase = "idle" | "loading" | "done" | "error";

/**
 * 让译文/错误块在**同一行的末尾换行**（而不是各占一个 flex item）。
 *
 * 回复块的操作行是 `display:flex; flex-wrap:wrap` —— 按钮跟「复制 / →桌面」排一行，
 * 译文块靠 `flex-basis:100%` 强制独占下一行。放在非 flex 容器（思考块）里时
 * flex 属性无效，不影响原来的块级纵向排列。
 */
const fullRowStyle: React.CSSProperties = { flex: "1 1 100%", width: "100%" };

/** 目标语言按当前界面语言走 —— 用户看不懂的就是"非界面语言"的内容。 */
function targetLanguage(): string {
  return getLanguage() === "zh" ? "Simplified Chinese" : "English";
}

/**
 * 组装旁问的提示词。
 *
 * 写死"只输出译文"这类约束：旁问不带会话上下文，模型只能靠这段指令约束输出，
 * 少了它常会回一句"以下是翻译："之类的客套话，甚至把原文一起抄回来。
 */
function buildPrompt(text: string): string {
  return [
    `Translate the following into ${targetLanguage()}.`,
    `Output ONLY the translation — no preamble, no explanation, no quoting, no code fences.`,
    `Keep code identifiers, file paths, and command names unchanged.`,
    ``,
    text,
  ].join("\n");
}

export function TranslateButton({ text, style }: {
  text: string;
  /** 让调用方微调按钮样式（思考块里偏小、回复区偏常规） */
  style?: React.CSSProperties;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [translation, setTranslation] = useState("");
  const [errorMsg, setErrorMsg] = useState("");

  const run = useCallback(async () => {
    setPhase("loading");
    setErrorMsg("");
    const r = await chatSession.askSideQuestion(buildPrompt(text));
    if (r.response) {
      setTranslation(r.response.trim());
      setPhase("done");
    } else {
      setErrorMsg(r.error ?? t("message.translateFailed"));
      setPhase("error");
    }
  }, [text]);

  const onClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation(); // 别触发消息块的其它点击行为
    if (phase === "loading") return;
    // 已有译文 → 再点收起（不重新请求，省一次 API）
    if (phase === "done") {
      setPhase("idle");
      setTranslation("");
      return;
    }
    void run();
  }, [phase, run]);

  const btnStyle: React.CSSProperties = {
    display: "inline-flex", alignItems: "center", gap: 4,
    border: "none", background: "none", cursor: phase === "loading" ? "default" : "pointer",
    fontSize: 10, color: "var(--fg-muted)", padding: "1px 6px", borderRadius: 3,
    fontFamily: "var(--font-sans)",
    ...style,
  };

  // ⚠️ 外层用 **fragment 而不是包一个 span**：
  // 回复块的操作行是 `display:flex`，包一层 span 会让整个组件变成一个 flex item
  // → 按钮必然另起一行（用户实测反馈："上面那行放不下？"—— 放得下，是我的结构问题）。
  // 用 fragment 后按钮成为操作行的**直接** flex 子元素，跟「复制 / →桌面」同行；
  // 译文块靠 `flex: 1 1 100%` 独占下一行（父容器需 flexWrap: wrap）。
  // 思考块那边不是 flex 容器，两者按块级流纵向排列，行为不变。
  return (
    <>
      <button
        type="button"
        style={btnStyle}
        onClick={onClick}
        title={t("message.translateHint")}
        onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = "var(--border-light)"; e.currentTarget.style.color = "var(--fg-primary)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = "transparent"; e.currentTarget.style.color = "var(--fg-muted)"; }}
      >
        <Languages size={11} />
        {phase === "loading" ? t("message.translating") : t("message.translate")}
      </button>

      {phase === "error" && (
        <div style={{
          fontSize: 11, color: "var(--semantic-error)", marginTop: 4,
          fontFamily: "var(--font-sans)",
          ...fullRowStyle,
        }}>
          {errorMsg}
        </div>
      )}

      {phase === "done" && translation && (
        <div style={{
          fontSize: 12, color: "var(--fg-primary)",
          padding: "6px 10px", marginTop: 4,
          backgroundColor: "var(--bg-code)", borderRadius: 6,
          border: "1px solid var(--border-light)",
          fontFamily: "var(--font-sans)",
          whiteSpace: "pre-wrap", overflowWrap: "anywhere",
          maxHeight: 300, overflow: "auto",
          position: "relative",
          textAlign: "left",
          ...fullRowStyle,
        }}>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setPhase("idle"); setTranslation(""); }}
            title={t("message.translateCollapse")}
            style={{
              position: "absolute", top: 4, right: 4,
              border: "none", background: "none", cursor: "pointer",
              color: "var(--fg-muted)", padding: 2, lineHeight: 0,
            }}
          >
            <X size={11} />
          </button>
          {translation}
        </div>
      )}
    </>
  );
}
