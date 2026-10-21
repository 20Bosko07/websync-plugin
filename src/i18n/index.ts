import { DEFAULT_LOCALE, LOCALES, setHistoryTexts, type Locale } from "@websync/shared";
import { de } from "./de";
import { en, type MessageKey } from "./en";
import { es } from "./es";
import { fr } from "./fr";
import { it } from "./it";
import { nl } from "./nl";

/**
 * Texts of the plugin in Obsidian's interface language (English when that is not one of ours). English is the source: a
 * key missing in another language falls back to it. `{name}` is replaced by a parameter.
 */
export type { MessageKey };

const translations: Record<Locale, Partial<Record<MessageKey, string>>> = { en, de, fr, es, it, nl };

/** Obsidian keeps the chosen interface language in localStorage ("language"; absent = English). */
export function currentLocale(): Locale {
  let raw = "";
  try {
    raw = window.localStorage.getItem("language") ?? "";
  } catch {
    /* no storage: English */
  }
  const code = raw.toLowerCase().split(/[-_]/)[0];
  return (LOCALES as readonly string[]).includes(code) ? (code as Locale) : DEFAULT_LOCALE;
}

export function t(key: MessageKey, params?: Record<string, string | number>): string {
  const text = translations[currentLocale()][key] ?? translations[DEFAULT_LOCALE][key] ?? key;
  return params ? text.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match)) : text;
}

/** Plural-aware `t`: `<key>_one` / `<key>_other` (...) by the plural rules of the interface language. */
export function tn(key: string, count: number, params?: Record<string, string | number>): string {
  const rule = new Intl.PluralRules(currentLocale()).select(count);
  const pick = (k: string) => translations[currentLocale()][k as MessageKey] ?? translations[DEFAULT_LOCALE][k as MessageKey];
  const text = pick(`${key}_${rule}`) ?? pick(`${key}_other`) ?? key;
  return text.replace(/\{(\w+)\}/g, (match, name: string) => (name === "count" ? String(count) : params && name in params ? String(params[name]) : match));
}

/** Gives the shared change-log code (labels, dates) the plugin's language. Call once on load. */
export function applyHistoryTexts(): void {
  setHistoryTexts({
    locale: currentLocale(),
    fileActions: { create: t("history.action.create"), modify: t("history.action.modify"), rename: t("history.action.rename"), delete: t("history.action.delete"), restore: t("history.action.restore") },
    folderActions: { create: t("history.folder.create"), modify: t("history.folder.create"), rename: t("history.folder.rename"), delete: t("history.folder.delete"), restore: t("history.folder.restore") },
    today: t("history.today"),
    yesterday: t("history.yesterday"),
    unknownDevice: t("history.unknownDevice"),
    unreadablePath: t("history.unreadablePath"),
  });
}
