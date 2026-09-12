import { useEffect, useState } from "react";
import zh from "./zh";
import en from "./en";
import type { Locale } from "./zh";
import { windowBus } from "../services/windowBus";
import { Events } from "../services/events";

export type Language = "zh" | "en";

const locales: Record<Language, Locale> = { zh, en };

let current: Language = "zh";

export function setLanguage(lang: Language) {
  if (current === lang) return;
  current = lang;
  windowBus.emit(Events.LANGUAGE_CHANGED, { language: current }, { sticky: true });
}

export function getLanguage(): Language {
  return current;
}

/** Translate a dot-separated key path. Supports `{key}` substitution. */
export function t(key: string, params?: Record<string, string | number>): string {
  const locale = locales[current];
  const parts = key.split(".");
  let val: any = locale;
  for (const p of parts) {
    if (val == null) break;
    val = val[p];
  }
  let result = typeof val === "string" ? val : key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      // replaceAll: 同一占位符可能出现多次(如更新提示词的 {to} 在「市场 v{to}」和
      // detail={"version":"{to}"} 里各一次)——replace 只换首处会漏出原文占位符。
      result = result.replaceAll(`{${k}}`, String(v));
    }
  }
  return result;
}

/** React hook: returns `t` bound to current language, re-renders on change. */
export function useT(): typeof t {
  const [, tick] = useState(0);
  useEffect(() => {
    return windowBus.on(Events.LANGUAGE_CHANGED, () => tick((n) => n + 1));
  }, []);
  return t;
}
