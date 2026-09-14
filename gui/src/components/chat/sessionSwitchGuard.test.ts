import { describe, it, expect } from "vitest";
import { shouldConfirmSwitch, switchDialogActions } from "./sessionSwitchGuard";

const S = "8f8b2e7d-1111-2222-3333-444455556666";

describe("shouldConfirmSwitch", () => {
  it("prompts when backend is busy and target is another session", () => {
    expect(shouldConfirmSwitch({ backendBusy: true }, S, "other-id")).toBe(true);
  });

  it("never prompts when the target is the current session", () => {
    expect(shouldConfirmSwitch({ backendBusy: true }, S, S)).toBe(false);
  });

  it("never prompts when backend is idle", () => {
    expect(shouldConfirmSwitch({ backendBusy: false }, S, "other-id")).toBe(false);
  });

  it("treats undefined busy as idle (backend has not reported yet)", () => {
    expect(shouldConfirmSwitch({ backendBusy: undefined }, S, "other-id")).toBe(false);
  });
});

describe("switchDialogActions", () => {
  it("cancel dismisses the dialog and does not switch", () => {
    expect(switchDialogActions(false)).toEqual({ dismiss: true, switchToTarget: false });
  });

  it("confirm dismisses the dialog and switches", () => {
    expect(switchDialogActions(true)).toEqual({ dismiss: true, switchToTarget: true });
  });
});
