import type { zhCN } from "./zh-CN.ts";

export type TranslationKey = keyof typeof zhCN;
export type TranslationDict = Record<TranslationKey, string>;
export type TranslationParams = Record<string, string | number>;
