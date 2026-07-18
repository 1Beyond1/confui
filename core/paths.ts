import { isAbsolute, resolve, sep } from "node:path";
import type { PathSegment } from "../shared/schema.ts";
import { ConfuiError } from "./errors.ts";

export function safeJoin(root: string, relativePath: string): string {
  if (!root.trim() || !relativePath.trim() || isAbsolute(relativePath)) {
    throw new ConfuiError("INVALID_INPUT", "文件路径无效");
  }
  const resolvedRoot = resolve(root);
  const joined = resolve(resolvedRoot, relativePath);
  if (joined !== resolvedRoot && !joined.startsWith(resolvedRoot + sep)) {
    throw new ConfuiError("INVALID_INPUT", "已拒绝访问项目目录之外的路径");
  }
  return joined;
}

export function pathKey(segments: readonly PathSegment[]): string {
  return JSON.stringify(segments);
}

export function formatPath(segments: readonly PathSegment[]): string {
  return segments
    .map((segment, index) => {
      if (typeof segment === "number") return `[${segment}]`;
      if (/^[A-Za-z_$][\w$-]*$/.test(segment)) return `${index ? "." : ""}${segment}`;
      return `[${JSON.stringify(segment)}]`;
    })
    .join("");
}

export function getAtPath(value: unknown, segments: readonly PathSegment[]): unknown {
  let current = value;
  for (const segment of segments) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<PathSegment, unknown>)[segment];
  }
  return current;
}

export function setAtPath(target: unknown, segments: readonly PathSegment[], value: unknown): void {
  if (!segments.length || target === null || typeof target !== "object") {
    throw new ConfuiError("INVALID_INPUT", "配置字段路径无效");
  }
  let current = target as Record<PathSegment, unknown>;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment === undefined) throw new ConfuiError("INVALID_INPUT", "配置字段路径无效");
    if (index === segments.length - 1) {
      current[segment] = value;
      return;
    }
    const nextSegment = segments[index + 1];
    const existing = current[segment];
    if (existing === null || typeof existing !== "object") {
      current[segment] = typeof nextSegment === "number" ? [] : {};
    }
    current = current[segment] as Record<PathSegment, unknown>;
  }
}

export function cloneValue<T>(value: T): T {
  return structuredClone(value);
}
