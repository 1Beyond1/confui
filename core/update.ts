import type { UpdateCheckResult } from "../shared/schema.ts";
import { ConfuiError } from "./errors.ts";

const RELEASE_API_URL = "https://api.github.com/repos/1Beyond1/confui/releases/latest";
const RELEASES_URL = "https://github.com/1Beyond1/confui/releases/latest";
const UPDATE_TIMEOUT_MS = 12_000;

export async function checkForUpdates(
  currentVersion: string,
  fetcher: typeof fetch = fetch,
): Promise<UpdateCheckResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPDATE_TIMEOUT_MS);
  try {
    const response = await fetcher(RELEASE_API_URL, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": `Confui/${currentVersion}`,
      },
      signal: controller.signal,
    });
    const responseText = await response.text();
    if (!response.ok) {
      throw new ConfuiError("NETWORK_ERROR", `GitHub 更新检查失败（${response.status}）`, responseText.slice(0, 300));
    }

    let payload: unknown;
    try {
      payload = JSON.parse(responseText);
    } catch {
      throw new ConfuiError("NETWORK_ERROR", "GitHub 更新接口返回了无效数据");
    }
    if (!isRecord(payload) || typeof payload.tag_name !== "string") {
      throw new ConfuiError("NETWORK_ERROR", "GitHub 更新接口缺少版本信息");
    }

    const latestVersion = normalizeVersion(payload.tag_name);
    if (!latestVersion) throw new ConfuiError("NETWORK_ERROR", "GitHub 返回了无法识别的版本号");
    const releaseUrl = typeof payload.html_url === "string" && payload.html_url.startsWith("https://github.com/1Beyond1/confui/releases/")
      ? payload.html_url
      : RELEASES_URL;

    return {
      currentVersion: normalizeVersion(currentVersion) ?? currentVersion,
      latestVersion,
      updateAvailable: compareVersions(latestVersion, currentVersion) > 0,
      releaseName: typeof payload.name === "string" && payload.name.trim() ? payload.name.trim() : `Confui v${latestVersion}`,
      releaseUrl,
      publishedAt: typeof payload.published_at === "string" ? payload.published_at : undefined,
    };
  } catch (error) {
    if (error instanceof ConfuiError) throw error;
    const message = error instanceof Error && error.name === "AbortError"
      ? "检查更新超时，请稍后重试"
      : error instanceof Error
        ? error.message
        : String(error);
    throw new ConfuiError("NETWORK_ERROR", "无法检查更新", message);
  } finally {
    clearTimeout(timeout);
  }
}

export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return 0;
  for (let index = 0; index < 3; index += 1) {
    const leftNumber = a.numbers[index] ?? 0;
    const rightNumber = b.numbers[index] ?? 0;
    if (leftNumber !== rightNumber) return leftNumber > rightNumber ? 1 : -1;
  }
  if (!a.prerelease && !b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  const limit = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < limit; index += 1) {
    const leftPart = a.prerelease[index];
    const rightPart = b.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumber = /^\d+$/.test(leftPart) ? Number(leftPart) : undefined;
    const rightNumber = /^\d+$/.test(rightPart) ? Number(rightPart) : undefined;
    if (leftNumber !== undefined && rightNumber !== undefined) return leftNumber > rightNumber ? 1 : -1;
    if (leftNumber !== undefined) return -1;
    if (rightNumber !== undefined) return 1;
    return leftPart > rightPart ? 1 : -1;
  }
  return 0;
}

function normalizeVersion(value: string): string | undefined {
  const parsed = parseVersion(value);
  if (!parsed) return undefined;
  return `${parsed.numbers.join(".")}${parsed.prerelease ? `-${parsed.prerelease.join(".")}` : ""}`;
}

function parseVersion(value: string): { numbers: [number, number, number]; prerelease?: string[] } | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(value.trim());
  if (!match) return undefined;
  return {
    numbers: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4]?.split("."),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
