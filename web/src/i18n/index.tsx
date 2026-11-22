import { createContext, type ComponentChildren } from "preact";
import { useContext } from "preact/hooks";
import type { FieldSource, FieldType, Locale } from "../../../shared/schema.ts";
import { enUS } from "./en-US.ts";
import type { TranslationDict, TranslationKey, TranslationParams } from "./types.ts";
import { zhCN } from "./zh-CN.ts";

export const DICTIONARIES: Record<Locale, TranslationDict> = {
  "zh-CN": zhCN,
  "en-US": enUS,
};

export function translate(
  locale: Locale,
  key: TranslationKey,
  params?: TranslationParams,
): string {
  const dict = DICTIONARIES[locale] ?? zhCN;
  let text = dict[key] ?? zhCN[key] ?? key;
  if (params) {
    for (const [name, value] of Object.entries(params)) {
      text = text.replaceAll(`{${name}}`, String(value));
    }
  }
  return text;
}

export function sourceLabel(locale: Locale, source: FieldSource): string {
  return translate(locale, `source.${source}`);
}

export function fieldTypeLabel(locale: Locale, type: FieldType): string {
  return translate(locale, `type.${type}`);
}

export interface I18nContextValue {
  locale: Locale;
  t: (key: TranslationKey, params?: TranslationParams) => string;
}

const I18nContext = createContext<I18nContextValue>({
  locale: "zh-CN",
  t: (key, params) => translate("zh-CN", key, params),
});

export function I18nProvider({
  locale,
  children,
}: {
  locale: Locale;
  children: ComponentChildren;
}) {
  const value: I18nContextValue = {
    locale,
    t: (key, params) => translate(locale, key, params),
  };
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  return useContext(I18nContext);
}

export type { TranslationDict, TranslationKey, TranslationParams };
