import type { FieldProperty, FieldSource, FieldSpec, PathSegment, SourceSummary } from "../../shared/schema.ts";
import { isHexColor } from "../../shared/validation.ts";
import { formatPath, pathKey } from "../paths.ts";
import { groupForPath, humanize } from "./common.ts";
import type { FieldCandidate } from "./types.ts";

const PRIORITY: Record<FieldSource, number> = {
  "json-schema": 600,
  "known-template": 500,
  example: 400,
  readme: 300,
  ai: 200,
  heuristic: 100,
};

/** Keep pathological but valid config files from freezing the renderer. */
export const MAX_FORM_FIELDS = 2_000;

const PROPERTIES: FieldProperty[] = [
  "label",
  "description",
  "type",
  "required",
  "default",
  "enum",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "pattern",
  "placeholder",
  "secret",
  "group",
];

export function mergeCandidates(candidates: readonly FieldCandidate[]): {
  fields: FieldSpec[];
  sources: SourceSummary[];
  truncated: boolean;
  totalFieldCount: number;
} {
  const groups = new Map<string, FieldCandidate[]>();
  for (const candidate of candidates) {
    const key = pathKey(candidate.segments);
    const existing = groups.get(key);
    if (existing) existing.push(candidate);
    else groups.set(key, [candidate]);
  }

  const fields = [...groups.entries()].map(([, group]) => {
    const ranked = [...group].sort(compareCandidates);
    const segments = ranked[0]?.segments ?? [];
    const leaf = String(segments.at(-1) ?? "字段");
    const evidence: FieldSpec["evidence"] = [];
    const chosen: Record<string, unknown> = {};

    for (const property of PROPERTIES) {
      const winner = ranked.find((candidate) => candidate[property] !== undefined);
      if (!winner) continue;
      chosen[property] = winner[property];
      evidence.push({
        property,
        source: winner.source,
        confidence: winner.confidence,
        detail: winner.detail,
      });
    }

    // Only the actual-file heuristic (or a known built-in template reading the
    // actual file) may populate the editor value. Example files are guidance;
    // using their `value` here would silently prefill fields that do not exist
    // in the user's config and could turn placeholders into edits.
    const valueCandidate = group.find((candidate) => candidate.source === "heuristic" && "value" in candidate)
      ?? group.find((candidate) => candidate.source === "known-template" && "value" in candidate);
    const strongest = evidence.find((item) => item.property === "description") ?? evidence[0];
    const source = strongest?.source ?? "heuristic";
    const type = (chosen.type as FieldSpec["type"] | undefined) ?? "string";
    const enumValues = chosen.enum as FieldSpec["enum"];
    return {
      path: formatPath(segments),
      segments,
      label: String(chosen.label ?? humanize(leaf)),
      description: asOptionalString(chosen.description),
      type,
      required: asOptionalBoolean(chosen.required),
      // README tables often omit a type and therefore parse a value such as
      // `true` or `001` as an untyped scalar. Normalize that guidance against
      // the winning field type before exposing the "use default" action; a
      // string field must never turn into a JSON boolean/number when the user
      // clicks that button.
      default: normalizeDefault(type, chosen.default, enumValues),
      value: valueCandidate?.value,
      enum: enumValues,
      minimum: asOptionalNumber(chosen.minimum),
      maximum: asOptionalNumber(chosen.maximum),
      minLength: asOptionalNumber(chosen.minLength),
      maxLength: asOptionalNumber(chosen.maxLength),
      pattern: asOptionalString(chosen.pattern),
      placeholder: asOptionalString(chosen.placeholder),
      secret: asOptionalBoolean(chosen.secret),
      group: String(chosen.group ?? groupForPath(segments)),
      source,
      confidence: Math.max(...evidence.map((item) => item.confidence), 0.5),
      evidence,
      order: Math.min(...group.map((item) => item.order ?? Number.MAX_SAFE_INTEGER)),
    } satisfies FieldSpec & { order: number };
  });

  const nonOverlappingFields = resolveOverlappingPaths(fields);
  nonOverlappingFields.sort((left, right) => left.order - right.order || left.path.localeCompare(right.path));
  const limitedOrderedFields = limitFields(nonOverlappingFields);
  const limitedFields = limitedOrderedFields.map(({ order: _order, ...field }) => field);
  const sources = (["json-schema", "known-template", "example", "readme", "ai", "heuristic"] as FieldSource[])
    .map((source) => ({
      source,
      fieldCount: limitedFields.filter((field) => field.evidence.some((item) => item.source === source)).length,
    }))
    .filter((summary) => summary.fieldCount > 0);
  return {
    fields: limitedFields,
    sources,
    truncated: nonOverlappingFields.length > limitedFields.length,
    totalFieldCount: nonOverlappingFields.length,
  };
}

/**
 * Eliminates overlapping ancestor/descendant field paths (for example a
 * heuristic-collapsed parent object alongside JSON Schema or example-expanded
 * children) so the form never presents two conflicting editors for the same
 * subtree and triggers a parent/child conflict on save.
 */
function resolveOverlappingPaths<T extends FieldSpec & { order: number }>(fields: readonly T[]): T[] {
  if (fields.length <= 1) return [...fields];
  const byLength = fields.map((field, index) => ({ field, index }))
    .sort((left, right) => left.field.segments.length - right.field.segments.length || left.index - right.index);
  const dropped = new Set<number>();

  for (let i = 0; i < byLength.length; i += 1) {
    const parentEntry = byLength[i]!;
    if (dropped.has(parentEntry.index)) continue;
    const descendants: Array<{ field: T; index: number }> = [];
    for (let j = i + 1; j < byLength.length; j += 1) {
      const candidate = byLength[j]!;
      if (dropped.has(candidate.index)) continue;
      if (isStrictPrefix(parentEntry.field.segments, candidate.field.segments)) {
        descendants.push(candidate);
      }
    }
    if (!descendants.length) continue;

    const parentPriority = strongestPriority(parentEntry.field);
    const maxDescendantPriority = Math.max(...descendants.map((item) => strongestPriority(item.field)));
    if (parentPriority >= maxDescendantPriority) {
      for (const descendant of descendants) dropped.add(descendant.index);
    } else {
      dropped.add(parentEntry.index);
    }
  }

  return fields.filter((_field, index) => !dropped.has(index));
}

function isStrictPrefix(prefix: readonly PathSegment[], path: readonly PathSegment[]): boolean {
  return prefix.length < path.length && prefix.every((segment, index) => segment === path[index]);
}

function limitFields(fields: Array<FieldSpec & { order: number }>): Array<FieldSpec & { order: number }> {
  if (fields.length <= MAX_FORM_FIELDS) return fields;
  // Prefer fields whose metadata comes from a stronger source, but restore
  // their original discovery order for display so the form still feels familiar.
  return [...fields]
    .sort((left, right) => strongestPriority(right) - strongestPriority(left) || left.order - right.order)
    .slice(0, MAX_FORM_FIELDS)
    .sort((left, right) => left.order - right.order || left.path.localeCompare(right.path));
}

function strongestPriority(field: FieldSpec): number {
  return Math.max(
    PRIORITY[field.source],
    ...field.evidence.map((item) => PRIORITY[item.source]),
  );
}

function compareCandidates(left: FieldCandidate, right: FieldCandidate): number {
  return PRIORITY[right.source] - PRIORITY[left.source]
    || right.confidence - left.confidence;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function normalizeDefault(
  type: FieldSpec["type"],
  value: unknown,
  enumValues: FieldSpec["enum"],
): unknown {
  if (value === undefined || value === null) return undefined;
  switch (type) {
    case "string":
    case "secret":
      if (typeof value === "string") return value;
      return typeof value === "number" || typeof value === "boolean" ? String(value) : undefined;
    case "color":
      return isHexColor(value) ? value : undefined;
    case "boolean":
      if (typeof value === "boolean") return value;
      if (typeof value === "string") {
        if (/^(?:true|yes|是|1|on)$/i.test(value.trim())) return true;
        if (/^(?:false|no|否|0|off)$/i.test(value.trim())) return false;
      }
      return undefined;
    case "integer": {
      const text = typeof value === "string" ? value.trim() : undefined;
      const number = typeof value === "number" ? value : text ? Number(text) : NaN;
      return Number.isSafeInteger(number) ? number : undefined;
    }
    case "number": {
      const text = typeof value === "string" ? value.trim() : undefined;
      const number = typeof value === "number" ? value : text ? Number(text) : NaN;
      return Number.isFinite(number) && (!Number.isInteger(number) || Number.isSafeInteger(number)) ? number : undefined;
    }
    case "enum": {
      if (!enumValues?.length) return undefined;
      return enumValues.find((option) => enumDefaultEqual(option, value));
    }
    case "array":
      return Array.isArray(value) ? value : undefined;
    case "json":
      return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
  }
}

function enumDefaultEqual(option: string | number, value: unknown): boolean {
  if (Object.is(option, value)) return true;
  if (typeof option === "number" && typeof value === "string" && value.trim() !== "") {
    const number = Number(value);
    return Number.isFinite(number) && number === option;
  }
  if (typeof option === "string" && typeof value === "number") {
    return Number.isFinite(value) && Number(option) === value;
  }
  return false;
}
