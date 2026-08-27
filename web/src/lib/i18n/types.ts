// i18n core types.
//
// A dictionary is a flat map of dotted keys (e.g. "nav.today") to a localized
// string. Every cluster file in `clusters/` exports its own `en` and `zh`
// slices; `index.ts` merges them into the two full dictionaries.

export type Lang = "en" | "zh";

export type Dict = Record<string, string>;

export const LANGS: Lang[] = ["en", "zh"];

export function isLang(v: unknown): v is Lang {
  return v === "en" || v === "zh";
}
