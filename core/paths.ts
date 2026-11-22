import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { PathSegment } from "../shared/schema.ts";
import { isSafePathSegment } from "../shared/validation.ts";
import { ConfuiError } from "./errors.ts";

export function safeJoin(root: string, relativePath: string): string {
  if (
    typeof root !== "string"
    || typeof relativePath !== "string"
    || !root.trim()
    || !relativePath.trim()
    || relativePath.includes("\0")
    || root.includes("\0")
    || isAbsolute(relativePath.trim())
  ) {
    throw new ConfuiError("INVALID_INPUT", "文件路径无效");
  }
  const resolvedRoot = resolve(root.trim());
  const joined = resolve(resolvedRoot, relativePath.trim());
  const outside = relative(resolvedRoot, joined);
  if (outside === ".." || outside.startsWith(`..${sep}`) || isAbsolute(outside)) {
    throw new ConfuiError("INVALID_INPUT", "已拒绝访问项目目录之外的路径");
  }
  return joined;
}

/**
 * Resolves an existing project file and verifies its physical path stays
 * inside the selected project. Lexical checks alone do not catch a symlink or
 * directory junction that points outside the project.
 */
export async function resolveExistingProjectPath(
  root: string,
  relativePath: string,
): Promise<{ root: string; path: string }> {
  try {
    const resolvedRoot = await realpath(resolve(root.trim()));
    const lexicalPath = safeJoin(resolvedRoot, relativePath);
    const resolvedPath = await realpath(lexicalPath);
    if (!isPathInside(resolvedRoot, resolvedPath)) {
      throw new ConfuiError("INVALID_INPUT", "已拒绝访问项目目录之外的路径");
    }
    return { root: resolvedRoot, path: resolvedPath };
  } catch (error) {
    if (error instanceof ConfuiError) throw error;
    throw new ConfuiError(
      "NOT_FOUND",
      "项目内文件不存在或无法访问",
      error instanceof Error ? error.message : String(error),
    );
  }
}

/** Resolves an existing path and rejects symlink/junction escapes. */
export async function ensurePathInsideProject(root: string, candidate: string): Promise<string> {
  try {
    const resolvedRoot = await realpath(resolve(root.trim()));
    const resolvedCandidate = await realpath(candidate);
    if (!isPathInside(resolvedRoot, resolvedCandidate)) {
      throw new ConfuiError("INVALID_INPUT", "已拒绝访问项目目录之外的路径");
    }
    return resolvedCandidate;
  } catch (error) {
    if (error instanceof ConfuiError) throw error;
    throw new ConfuiError(
      "NOT_FOUND",
      "项目内路径不存在或无法访问",
      error instanceof Error ? error.message : String(error),
    );
  }
}

export function isPathInside(root: string, candidate: string): boolean {
  const outside = relative(resolve(root), resolve(candidate));
  return outside === "" || (outside !== ".." && !outside.startsWith(`..${sep}`) && !isAbsolute(outside));
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
    if (!isSafeSegment(segment) || current === null || typeof current !== "object") return undefined;
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
    current = (current as Record<PathSegment, unknown>)[segment];
  }
  return current;
}

export function setAtPath(target: unknown, segments: readonly PathSegment[], value: unknown): void {
  if (!segments.length || target === null || typeof target !== "object") {
    throw new ConfuiError("INVALID_INPUT", "配置字段路径无效");
  }
  if (segments.some((segment) => !isSafeSegment(segment))) {
    throw new ConfuiError("INVALID_INPUT", "配置字段路径包含不安全的键名");
  }
  let current = target as Record<PathSegment, unknown>;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment === undefined) throw new ConfuiError("INVALID_INPUT", "配置字段路径无效");
    if (Array.isArray(current) && typeof segment !== "number") {
      throw new ConfuiError("INVALID_INPUT", "数组字段路径无效");
    }
    if (!Array.isArray(current) && typeof segment === "number") {
      throw new ConfuiError("INVALID_INPUT", "数组字段路径无效");
    }
    if (Array.isArray(current) && typeof segment === "number" && segment > current.length) {
      throw new ConfuiError("INVALID_INPUT", "数组下标不能跳过空元素");
    }
    if (index === segments.length - 1) {
      current[segment] = value;
      return;
    }
    const nextSegment = segments[index + 1];
    const existing = Object.prototype.hasOwnProperty.call(current, segment)
      ? current[segment]
      : undefined;
    if (existing === null || typeof existing !== "object") {
      current[segment] = typeof nextSegment === "number" ? [] : {};
    }
    current = current[segment] as Record<PathSegment, unknown>;
  }
}

/** Removes one existing property without creating prototype or array holes. */
export function deleteAtPath(target: unknown, segments: readonly PathSegment[]): void {
  if (!segments.length || target === null || typeof target !== "object") return;
  if (segments.some((segment) => !isSafeSegment(segment))) return;
  let current: unknown = target;
  for (let index = 0; index < segments.length; index += 1) {
    if (current === null || typeof current !== "object") return;
    const segment = segments[index];
    if (segment === undefined || !Object.prototype.hasOwnProperty.call(current, segment)) return;
    if (Array.isArray(current) && typeof segment !== "number") return;
    if (!Array.isArray(current) && typeof segment !== "string") return;
    if (index === segments.length - 1) {
      if (Array.isArray(current) && typeof segment === "number") current.splice(segment, 1);
      else delete (current as Record<PathSegment, unknown>)[segment];
      return;
    }
    current = (current as Record<PathSegment, unknown>)[segment];
  }
}

function isSafeSegment(segment: PathSegment): boolean {
  return isSafePathSegment(segment);
}

export function cloneValue<T>(value: T): T {
  return structuredClone(value);
}
