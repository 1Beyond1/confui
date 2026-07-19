import { afterEach, describe, expect, it, vi } from "vitest";
import { checkForUpdates, compareVersions } from "../core/update.ts";

afterEach(() => vi.restoreAllMocks());

describe("update checker", () => {
  it("detects a newer GitHub release", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      tag_name: "v0.3.0",
      name: "Confui v0.3.0",
      html_url: "https://github.com/1Beyond1/confui/releases/tag/v0.3.0",
      published_at: "2026-07-19T00:00:00Z",
    }), { status: 200 }));

    await expect(checkForUpdates("0.2.2")).resolves.toMatchObject({
      currentVersion: "0.2.2",
      latestVersion: "0.3.0",
      updateAvailable: true,
      releaseName: "Confui v0.3.0",
    });
  });

  it("reports the current version when the release is not newer", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      tag_name: "v0.2.2",
      html_url: "https://github.com/1Beyond1/confui/releases/tag/v0.2.2",
    }), { status: 200 }));

    await expect(checkForUpdates("0.2.2")).resolves.toMatchObject({
      latestVersion: "0.2.2",
      updateAvailable: false,
    });
  });

  it("compares numeric and prerelease versions correctly", () => {
    expect(compareVersions("0.10.0", "0.9.9")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "1.0.0-rc.1")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0-beta.2", "1.0.0-beta.10")).toBeLessThan(0);
  });

  it("normalizes GitHub errors", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("rate limited", { status: 403 }));

    await expect(checkForUpdates("0.2.2")).rejects.toMatchObject({
      code: "NETWORK_ERROR",
      message: "GitHub 更新检查失败（403）",
      detail: "rate limited",
    });
  });
});
