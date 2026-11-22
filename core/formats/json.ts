import {
  applyEdits,
  modify,
  parse,
  printParseErrorCode,
  visit,
  type FormattingOptions,
  type ParseError,
} from "jsonc-parser";
import type { ConfigChange, PathSegment } from "../../shared/schema.ts";
import { formatPath } from "../paths.ts";

export function parseJsonc(source: string): unknown {
  const errors: ParseError[] = [];
  const value = parse(source, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length) {
    const first = errors[0]!;
    throw new Error(`${printParseErrorCode(first.error)} @ ${first.offset}`);
  }
  assertNoDuplicateJsonKeys(source);
  return value;
}

export function stringifyJsonc(value: unknown, originalText = ""): string {
  return JSON.stringify(value, null, detectIndent(originalText));
}

export function updateJsonc(originalText: string, changes: readonly ConfigChange[]): string {
  let output = originalText;
  const formattingOptions = detectFormattingOptions(originalText);
  for (const change of changes) {
    const edits = modify(output, change.segments, change.value, { formattingOptions });
    output = applyEdits(output, edits);
  }
  return output;
}

function assertNoDuplicateJsonKeys(text: string): void {
  const seen = new Set<string>();
  let duplicate: PathSegment[] | undefined;
  visit(text, {
    onObjectProperty(property, _offset, _length, _line, _character, pathSupplier) {
      const path = [...pathSupplier(), property] as PathSegment[];
      const id = JSON.stringify(path);
      if (seen.has(id)) duplicate ??= path;
      else seen.add(id);
    },
  }, { allowTrailingComma: true, disallowComments: false });
  if (duplicate) throw new Error(`存在重复的 JSON 键：${formatPath(duplicate)}`);
}

function detectFormattingOptions(text: string): FormattingOptions {
  const indentMatch = text.match(/\n([ \t]+)["'}\w]/);
  const indent = indentMatch?.[1] ?? "  ";
  return {
    insertSpaces: !indent.includes("\t"),
    tabSize: indent.includes("\t") ? 1 : Math.max(1, indent.length),
    eol: text.includes("\r\n") ? "\r\n" : "\n",
  };
}

function detectIndent(text: string): string | number {
  const indent = text.match(/\n([ \t]+)["'}\w]/)?.[1];
  if (!indent) return 2;
  return indent.includes("\t") ? "\t" : indent.length;
}
