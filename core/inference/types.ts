import type { FieldSource, FieldSpec, PathSegment } from "../../shared/schema.ts";

export type CandidateProperties = Partial<Pick<
  FieldSpec,
  | "label"
  | "description"
  | "type"
  | "required"
  | "default"
  | "enum"
  | "minimum"
  | "maximum"
  | "minLength"
  | "maxLength"
  | "pattern"
  | "placeholder"
  | "secret"
  | "group"
>>;

export interface FieldCandidate extends CandidateProperties {
  segments: PathSegment[];
  source: FieldSource;
  confidence: number;
  detail?: string;
  value?: unknown;
  order?: number;
}
