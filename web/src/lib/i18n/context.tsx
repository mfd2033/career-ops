"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { Lang } from "./types";
import { isLang } from "./types";
import { format, translate } from "./index";

// Persistence keys. The *current* language is the user's live selection; the
// *default* language is what the app shows on first load when no explicit
// selection has been made yet (e.g. a fresh browser / new device).
const DEFAULT_LANG_KEY = "career-ops:default-lang";
const LANG_KEY = "career-ops:lang";

type I18nValue = {
  lang: Lang;
  setLang: (l: Lang) => void;
  defaultLang: Lang;
  setDefaultLang: (l: Lang) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
};

const I18nContext = createContext<I18nValue | null>(null);

// The pre-paint script in layout.tsx sets window.__CO_LANG__ so the persisted
// language is applied as early as possible. The *initial* state must stay the
// server default ("en") so hydration sees identical text/aria-labels to the
// SSR HTML — reading __CO_LANG__ during the first client render would re-render
// the tree in a different language and fail hydration. The mount effect below
// then applies the real language before the user perceives a difference.
function initialLang(): Lang {
  if (typeof window !== "undefined") {
    const w = window as unknown as { __CO_LANG__?: unknown };
    if (isLang(w.__CO_LANG__)) return w.__CO_LANG__;
  }
  return "en";
}

export function LangProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Lang>("en");
  const [defaultLang, setDefaultLangState] = useState<Lang>("en");

  // Hydrate persisted values once on mount (localStorage is not available
  // during SSR; the pre-paint script already handled the very first frame).
  useEffect(() => {
    let def: Lang = "en";
    let cur: Lang = initialLang();
    try {
      const d = localStorage.getItem(DEFAULT_LANG_KEY);
      if (isLang(d)) def = d;
      const c = localStorage.getItem(LANG_KEY);
      if (isLang(c)) cur = c;
    } catch {
      /* ignore */
    }
    setDefaultLangState(def);
    setLangState(cur);
    document.documentElement.lang = cur;
  }, []);

  const applyLang = useCallback((next: Lang) => {
    setLangState(next);
    document.documentElement.lang = next;
    try {
      localStorage.setItem(LANG_KEY, next);
    } catch {
      /* ignore */
    }
  }, []);

  const setLang = useCallback(
    (next: Lang) => {
      if (!isLang(next)) return;
      applyLang(next);
    },
    [applyLang],
  );

  const setDefaultLang = useCallback(
    (next: Lang) => {
      if (!isLang(next)) return;
      setDefaultLangState(next);
      try {
        localStorage.setItem(DEFAULT_LANG_KEY, next);
      } catch {
        /* ignore */
      }
    },
    [],
  );

  const t = useCallback(
    (key: string, params?: Record<string, string | number>) => format(translate(lang, key), params),
    [lang],
  );

  const value = useMemo<I18nValue>(
    () => ({ lang, setLang, defaultLang, setDefaultLang, t }),
    [lang, setLang, defaultLang, setDefaultLang, t],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    // Allow usage outside a provider (e.g. a non-client helper) by degrading to
    // English passthrough rather than crashing.
    return {
      lang: "en",
      setLang: () => {},
      defaultLang: "en",
      setDefaultLang: () => {},
      t: (key) => key,
    };
  }
  return ctx;
}
