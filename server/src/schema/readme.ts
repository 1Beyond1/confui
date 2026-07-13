import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { FieldSpec } from "../../../shared/schema.ts";

export interface ReadmeResult {
  fields: FieldSpec[];
  readmeText: string;
  source: "local" | "github";
}

/** Try to read README from the project root. */
export async function readLocalReadme(projectRoot: string): Promise<string | null> {
  const candidates = ["README.md", "README.rst", "README.txt", "readme.md", "docs/README.md"];
  for (const c of candidates) {
    try {
      return await readFile(join(projectRoot, c), "utf8");
    } catch {}
  }
  return null;
}

/** Fetch README from GitHub API (fallback when no local README). */
export async function fetchGithubReadme(owner: string, repo: string, token?: string): Promise<string | null> {
  const url = `https://api.github.com/repos/${owner}/${repo}/readme`;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3.raw",
    "User-Agent": "confui",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    const res = await fetch(url, { headers });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/** Parse README to extract config field hints. */
export function parseReadmeForConfig(readme: string): FieldSpec[] {
  const fields: FieldSpec[] = [];
  const lines = readme.split("\n");

  // 1. Markdown tables: | Field | Description | Default |
  let inTable = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes("|") && line.trim().startsWith("|")) {
      const cells = line.split("|").map((c) => c.trim()).filter(Boolean);
      if (cells.length >= 2 && !line.includes("---")) {
        // skip header separator
        if (cells.every((c) => /^-+$/.test(c))) { inTable = false; continue; }
        // Check if this looks like a config table (first cell is a key-like string)
        const key = cells[0];
        if (/^[a-zA-Z_][\w.\-]*$/.test(key) && key.length < 80) {
          const description = cells[1] || undefined;
          const defaultVal = cells[2] ? tryParse(cells[2]) : undefined;
          fields.push({
            path: key,
            label: humanize(key),
            description,
            default: defaultVal,
            type: inferTypeStr(defaultVal),
            source: "readme",
          });
          inTable = true;
        }
      }
    } else {
      inTable = false;
    }
  }

  // 2. Environment variable sections: ## Environment Variables -> KEY=value
  let inEnvSection = false;
  for (const line of lines) {
    if (/^#{1,4}\s*(environment\s*variables?|env|configuration|config|settings)/i.test(line.trim())) {
      inEnvSection = true;
      continue;
    }
    if (inEnvSection) {
      if (/^#{1,4}\s/.test(line.trim())) { inEnvSection = false; continue; }
      // KEY=value or KEY: value
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*[=:]\s*(.*)/);
      if (m) {
        const key = m[1];
        const val = m[2].replace(/[#].*$/, "").trim().replace(/^["']|["']$/g, "");
        if (!fields.find((f) => f.path === key)) {
          fields.push({
            path: key,
            label: humanize(key),
            value: val || undefined,
            default: val || undefined,
            type: /password|secret|token|key/i.test(key) ? "secret" : "string",
            source: "readme",
          });
        }
      }
    }
  }

  return fields;
}

/** Main entry: get README (local first, GitHub fallback) and parse it. */
export async function getReadmeFields(
  projectRoot: string,
  githubUrl?: string
): Promise<ReadmeResult | null> {
  let readmeText = await readLocalReadme(projectRoot);
  let source: "local" | "github" = "local";

  if (!readmeText && githubUrl) {
    const match = githubUrl.match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/|$)/);
    if (match) {
      readmeText = await fetchGithubReadme(match[1], match[2]);
      source = "github";
    }
  }

  if (!readmeText) return null;
  const fields = parseReadmeForConfig(readmeText);
  return { fields, readmeText, source };
}

function humanize(s: string): string {
  return s.replace(/[_\-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).trim();
}

function tryParse(s: string): unknown {
  if (s === "true") return true;
  if (s === "false") return false;
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (/^-?\d+\.\d+$/.test(s)) return parseFloat(s);
  return s;
}

function inferTypeStr(v: unknown): FieldSpec["type"] {
  if (typeof v === "boolean") return "boolean";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return "string";
}
