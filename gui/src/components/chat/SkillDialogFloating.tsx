import { useEffect } from "react";
import { getChatState } from "../../stores/chatStore";
import { removeFloatingPanel, getFloatingPanels } from "../../stores/layoutStore";
import { SkillDialog } from "./SkillDialog";

// Module-level callbacks only — skill data lives in chatStore (survives drag re-renders)
let _onSend: ((text: string) => void) | null = null;
let _onSkip: (() => void) | null = null;
let _onToggleFav: (() => void) | null = null;
let _floatId: string | null = null;

export function setSkillDialogCallbacks(
  floatId: string,
  onSend: (text: string) => void,
  onSkip: () => void,
  onToggleFav: () => void,
) {
  _floatId = floatId;
  _onSend = onSend;
  _onSkip = onSkip;
  _onToggleFav = onToggleFav;
}

export function clearSkillDialogCallbacks() {
  _floatId = null;
  _onSend = null;
  _onSkip = null;
  _onToggleFav = null;
}

export function SkillDialogFloating() {
  const dlg = getChatState().activeSkillDialog;

  // Auto-skip when floating window is closed via FloatingRenderer's × button.
  // Only fire if the float was actually removed — not during drag re-renders.
  useEffect(() => {
    return () => {
      if (!_floatId) return;
      const stillExists = getFloatingPanels().some((fp) => fp.id === _floatId);
      if (!stillExists && _onSkip) { _onSkip(); clearSkillDialogCallbacks(); }
    };
  }, []);

  if (!dlg) return null;

  return (
    <SkillDialog
      skill={dlg.skill}
      isFavorite={dlg.isFav}
      onToggleFavorite={() => _onToggleFav?.()}
      onSend={(text) => {
        if (_onSend) _onSend(text);
        const fid = _floatId;
        clearSkillDialogCallbacks();  // before removing panel, so cleanup doesn't double-fire
        if (fid) removeFloatingPanel(fid);
      }}
      onClose={() => {
        const cb = _onSkip;
        const fid = _floatId;
        clearSkillDialogCallbacks();
        if (cb) cb();
        if (fid) removeFloatingPanel(fid);
      }}
    />
  );
}
