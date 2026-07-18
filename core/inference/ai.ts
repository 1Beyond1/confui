import type { ConfigFormat, FieldSpec, PathSegment } from "../../shared/schema.ts";
import type { AIProvider } from "../ai/provider.ts";
import { formatPath, getAtPath, pathKey } from "../paths.ts";
import { isSecretPath } from "./common.ts";
import type { FieldCandidate } from "./types.ts";

const VALID_TYPES = new Set<FieldSpec["type"]>([
  "string", "number", "integer", "boolean", "enum", "secret", "color", "array", "json",
]);

export async function inferAIFields(options: {
  provider: AIProvider;
  file: string;
  format: ConfigFormat;
  maskedValue: unknown;
  availablePaths: readonly PathSegment[][];
  readmeContext: string;
  exampleContext: string;
}): Promise<FieldCandidate[]> {
  const pathMap = new Map(options.availablePaths.map((segments) => [normalizePath(formatPath(segments)), [...segments]]));
  const available = options.availablePaths.map((segments) => formatPath(segments));
  const prompt = `分析配置文件并补充表单字段信息。只能使用“可用字段路径”中的 path，不要创造字段，也不要猜测密钥的值。

文件：${options.file}
格式：${options.format}
可用字段路径：${JSON.stringify(available)}

配置内容（敏感值已经替换为 ***）：
${JSON.stringify(options.maskedValue, null, 2).slice(0, 80_000)}

示例配置：
${options.exampleContext.slice(0, 16_000) || "（无）"}

README：
${options.readmeContext.slice(0, 24_000) || "（无）"}

只返回 JSON：
{"fields":[{"path":"server.port","label":"端口","description":"服务监听端口。","type":"integer","required":false,"default":3000,"enum":[],"minimum":1,"maximum":65535,"placeholder":"3000","secret":false,"group":"服务"}]}

规则：description 使用简短、明确的中文；不确定的属性直接省略；不要输出 value。`;

  const raw = await options.provider.chat([
    {
      role: "system",
      content: "你是配置文件分析器。依据项目文档解释字段，严格输出 JSON，不泄露或复述敏感值。",
    },
    { role: "user", content: prompt },
  ], { json: true, temperature: 0.1, maxTokens: 3_500 });

  const parsed = parseJsonResponse(raw);
  if (!Array.isArray(parsed.fields)) return [];
  const fields: FieldCandidate[] = [];
  for (const [index, rawField] of parsed.fields.entries()) {
    if (index >= 200) break;
    if (!isRecord(rawField) || typeof rawField.path !== "string") continue;
    const segments = pathMap.get(normalizePath(rawField.path));
    if (!segments) continue;
    const enumValues = Array.isArray(rawField.enum)
      ? rawField.enum.filter((item): item is string | number => typeof item === "string" || typeof item === "number")
        .slice(0, 100)
      : undefined;
    const proposedType = typeof rawField.type === "string" && VALID_TYPES.has(rawField.type as FieldSpec["type"])
      ? rawField.type as FieldSpec["type"]
      : undefined;
    const secret = isSecretPath(segments) || asBoolean(rawField.secret) === true;
    const type = secret
      ? "secret"
      : proposedType && isCompatibleType(proposedType, getAtPath(options.maskedValue, segments), enumValues)
        ? proposedType
        : undefined;
    fields.push({
      segments,
      label: asString(rawField.label),
      description: asString(rawField.description),
      type,
      required: asBoolean(rawField.required),
      default: safeDefault(rawField.default),
      enum: enumValues?.length ? enumValues : undefined,
      minimum: asNumber(rawField.minimum),
      maximum: asNumber(rawField.maximum),
      minLength: asNumber(rawField.minLength),
      maxLength: asNumber(rawField.maxLength),
      pattern: asString(rawField.pattern),
      placeholder: asString(rawField.placeholder),
      secret: secret ? true : asBoolean(rawField.secret),
      group: asString(rawField.group),
      source: "ai",
      confidence: 0.7,
      detail: "由用户配置的 AI 服务分析",
      order: 30_000 + index,
    });
  }
  return deduplicate(fields);
}

function parseJsonResponse(raw: string): Record<string, unknown> {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    const value = JSON.parse(cleaned);
    return isRecord(value) ? value : {};
  } catch {
    const object = cleaned.match(/\{[\s\S]*\}/)?.[0];
    if (!object) return {};
    try {
      const value = JSON.parse(object);
      return isRecord(value) ? value : {};
    } catch {
      return {};
    }
  }
}

function deduplicate(fields: FieldCandidate[]): FieldCandidate[] {
  const seen = new Set<string>();
  return fields.filter((field) => {
    const key = pathKey(field.segments);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizePath(value: string): string {
  return value.toLowerCase().replace(/[\s`"']/g, "").replace(/\[(?:"|')?([^\]"']+)(?:"|')?\]/g, ".$1").replace(/^\./, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 500) : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function safeDefault(value: unknown): unknown {
  try {
    const serialized = JSON.stringify(value);
    return serialized && serialized.length <= 4_000 ? value : undefined;
  } catch {
    return undefined;
  }
}

function isCompatibleType(type: FieldSpec["type"], value: unknown, enumValues?: Array<string | number>): boolean {
  if (value === undefined || value === null) return true;
  switch (type) {
    case "number":
      return typeof value === "number" || typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value));
    case "integer":
      return typeof value === "number" && Number.isInteger(value)
        || typeof value === "string" && value.trim() !== "" && Number.isInteger(Number(value));
    case "boolean":
      return typeof value === "boolean" || typeof value === "string" && /^(?:true|false|1|0|yes|no|on|off)$/i.test(value.trim());
    case "enum":
      return Boolean(enumValues?.length && enumValues.some((item) => String(item) === String(value)));
    case "array":
      return Array.isArray(value);
    case "json":
      return value !== null && typeof value === "object" && !Array.isArray(value);
    case "color":
      return typeof value === "string" && /^#[\da-f]{3,8}$/i.test(value);
    case "secret":
    case "string":
      return typeof value === "string" || value === undefined || value === null;
  }
}
