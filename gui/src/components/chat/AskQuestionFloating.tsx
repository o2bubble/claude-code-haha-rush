import { useEffect, useRef } from "react";
import { getChatState } from "../../stores/chatStore";
import { removeFloatingPanel } from "../../stores/layoutStore";
import { AskQuestionOverlay } from "./AskQuestionOverlay";

// Module-level callbacks — set by openAskQuestionFloat, consumed by this panel
let _onSubmit: ((answers: Record<string, string>, annotations: Record<string, { notes?: string }>) => void) | null = null;
let _onSkip: (() => void) | null = null;
let _floatId: string | null = null;

export function setAskQuestionCallbacks(
  floatId: string,
  onSubmit: (answers: Record<string, string>, annotations: Record<string, { notes?: string }>) => void,
  onSkip: () => void,
) {
  _floatId = floatId;
  _onSubmit = onSubmit;
  _onSkip = onSkip;
}

export function clearAskQuestionCallbacks() {
  _floatId = null;
  _onSubmit = null;
  _onSkip = null;
}

export function AskQuestionFloating() {
  const req = getChatState().pendingControlRequest;
  const questions: any[] = (req?.tool_input as any)?.questions || [];
  const realMount = useRef(false);

  // Auto-skip when floating window is closed via FloatingRenderer's × button.
  // Guarded by realMount ref to prevent StrictMode double-mount from
  // firing _onSkip on the first (test) unmount.
  useEffect(() => {
    realMount.current = true;
    return () => {
      realMount.current = false;
      // Use setTimeout so StrictMode re-mount sets realMount=true before timer fires
      setTimeout(() => {
        if (!realMount.current && _onSkip) {
          _onSkip();
          clearAskQuestionCallbacks();
        }
      }, 0);
    };
  }, []);

  if (questions.length === 0) return null;

  return (
    <AskQuestionOverlay
      questions={questions}
      onSubmit={(answers, annotations) => {
        if (_onSubmit) _onSubmit(answers, annotations);
        clearAskQuestionCallbacks();  // before removing panel, so cleanup doesn't double-fire
        if (_floatId) removeFloatingPanel(_floatId);
      }}
      onSkip={() => {
        const cb = _onSkip;
        clearAskQuestionCallbacks();  // clear before panel removal to prevent cleanup double-fire
        if (cb) cb();
        if (_floatId) removeFloatingPanel(_floatId);
      }}
    />
  );
}
