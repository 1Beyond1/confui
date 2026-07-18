import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAICompatibleProvider } from "../core/ai/provider.ts";

afterEach(() => vi.restoreAllMocks());

describe("OpenAI-compatible provider", () => {
  it("normalizes an error from the non-JSON fallback request", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("json mode unsupported", { status: 400 }))
      .mockResolvedValueOnce(new Response("bad credentials", { status: 401 }));
    const provider = new OpenAICompatibleProvider({
      enabled: true,
      provider: "custom",
      model: "test-model",
      baseUrl: "https://provider.example/v1",
      apiKey: "secret",
      timeoutMs: 5_000,
    });

    await expect(provider.chat([{ role: "user", content: "test" }], { json: true })).rejects.toMatchObject({
      code: "AI_ERROR",
      message: "AI 服务返回 401",
      detail: "bad credentials",
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
