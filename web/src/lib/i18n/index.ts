import type { Lang, Dict } from "./types";
import { en as navEn, zh as navZh } from "./clusters/nav";
import { en as sharedEn, zh as sharedZh } from "./clusters/shared";
import { en as homeEn, zh as homeZh } from "./clusters/home";
import { en as pipelineEn, zh as pipelineZh } from "./clusters/pipeline";
import { en as exploreEn, zh as exploreZh } from "./clusters/explore";
import { en as applyEn, zh as applyZh } from "./clusters/apply";
import { en as analyticsEn, zh as analyticsZh } from "./clusters/analytics";
import { en as followupsEn, zh as followupsZh } from "./clusters/followups";
import { en as cvEn, zh as cvZh } from "./clusters/cv";
import { en as configEn, zh as configZh } from "./clusters/config";
import { en as portalsEn, zh as portalsZh } from "./clusters/portals";
import { en as jobsEn, zh as jobsZh } from "./clusters/jobs";
import { en as inboxEn, zh as inboxZh } from "./clusters/inbox";

// Full dictionaries per language: flat key -> localized string.
export const dictionaries: Record<Lang, Dict> = {
  en: {
    ...navEn,
    ...sharedEn,
    ...homeEn,
    ...pipelineEn,
    ...exploreEn,
    ...applyEn,
    ...analyticsEn,
    ...followupsEn,
    ...cvEn,
    ...configEn,
    ...portalsEn,
    ...jobsEn,
    ...inboxEn,
  },
  zh: {
    ...navZh,
    ...sharedZh,
    ...homeZh,
    ...pipelineZh,
    ...exploreZh,
    ...applyZh,
    ...analyticsZh,
    ...followupsZh,
    ...cvZh,
    ...configZh,
    ...portalsZh,
    ...jobsZh,
    ...inboxZh,
  },
};

// Resolve a key for a language, falling back to English, then to the raw key
// itself so an untranslated/unknown key never crashes the UI.
export function translate(lang: Lang, key: string): string {
  const dict = dictionaries[lang];
  if (Object.prototype.hasOwnProperty.call(dict, key)) return dict[key];
  if (lang !== "en" && Object.prototype.hasOwnProperty.call(dictionaries.en, key)) {
    return dictionaries.en[key];
  }
  return key;
}

// Interpolate `{name}` placeholders in a resolved string with `params`.
export function format(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (m, name) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : m,
  );
}
