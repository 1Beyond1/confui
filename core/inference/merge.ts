import type { FieldProperty, FieldSource, FieldSpec, SourceSummary } from "../../shared/schema.ts";
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
} {
  const groups = new Map<string, FieldCandidate[]>();
  for (const candidate of candidates) {
    const key = pathKey(candidate.segments);
    const existing = groups.get(key);
    if (existing) existing.push(candidate);
    else groups.set(key, [candidate]);
  }

  const sourcePaths = new Map<FieldSource, Set<string>>();
  const fields = [...groups.entries()].map(([key, group]) => {
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
      const paths = sourcePaths.get(winner.source) ?? new Set<string>();
      paths.add(key);
      sourcePaths.set(winner.source, paths);
    }

    const valueCandidate = group.find((candidate) => candidate.source === "heuristic" && "value" in candidate)
      ?? group.find((candidate) => "value" in candidate);
    const strongest = evidence.find((item) => item.property === "description") ?? evidence[0];
    const source = strongest?.source ?? "heuristic";
    return {
      path: formatPath(segments),
      segments,
      label: String(chosen.label ?? humanize(leaf)),
      description: asOptionalString(chosen.description),
      type: (chosen.type as FieldSpec["type"] | undefined) ?? "string",
      required: asOptionalBoolean(chosen.required),
      default: chosen.default,
      value: valueCandidate?.value,
      enum: chosen.enum as FieldSpec["enum"],
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

  fields.sort((left, right) => left.order - right.order || left.path.localeCompare(right.path));
  const cleanFields = fields.map(({ order: _order, ...field }) => field);
  const sources = (["json-schema", "known-template", "example", "readme", "ai", "heuristic"] as FieldSource[])
    .map((source) => ({ source, fieldCount: sourcePaths.get(source)?.size ?? 0 }))
    .filter((summary) => summary.fieldCount > 0);
  return { fields: cleanFields, sources };
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
