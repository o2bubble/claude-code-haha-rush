import { createContext, useContext, useState, useCallback } from 'react';

// Locale imports
import { zhCN } from '../locales/zh-CN';
import { en } from '../locales/en';

const LOCALES = { 'zh-CN': zhCN, en };
const DEFAULT_LOCALE = 'zh-CN';

const I18nContext = createContext(null);

export function I18nProvider({ children }) {
  const [locale, setLocale] = useState(() => {
    return localStorage.getItem('memory_web_locale') || DEFAULT_LOCALE;
  });

  const t = useCallback((key, params) => {
    const strings = LOCALES[locale] || LOCALES[DEFAULT_LOCALE];
    let text = strings[key] ?? LOCALES[DEFAULT_LOCALE][key] ?? key;
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        text = text.replace(`{${k}}`, v);
      }
    }
    return text;
  }, [locale]);

  const changeLocale = useCallback((loc) => {
    setLocale(loc);
    localStorage.setItem('memory_web_locale', loc);
  }, []);

  return (
    <I18nContext.Provider value={{ t, locale, changeLocale }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useT() {
  const ctx = useContext(I18nContext);
  return ctx || { t: (k) => k, locale: DEFAULT_LOCALE, changeLocale: () => {} };
}
