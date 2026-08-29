import { afterEach, describe, expect, it, vi } from "vitest";
import { endpointFor, OpenAICompatibleProvider } from "../core/ai/provider.ts";

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

  it("only builds an endpoint from an http or https Base URL", () => {
    expect(endpointFor("https://provider.example/v1")).toBe("https://provider.example/v1/chat/completions");
    expect(endpointFor("http://127.0.0.1:11434/v1/")).toBe("http://127.0.0.1:11434/v1/chat/completions");
    expect(endpointFor("http://127.0.0.1:11434/v1/chat/completions"))
      .toBe("http://127.0.0.1:11434/v1/chat/completions");
    expect(endpointFor("https://provider.example/v1/chat/completions/"))
      .toBe("https://provider.example/v1/chat/completions");

    for (const bad of ["file:///c:/windows/win.ini", "data:application/json,{}", "ftp://example.com/v1"]) {
      expect(() => endpointFor(bad)).toThrow(/只支持 http 或 https/);
    }
    expect(() => endpointFor("provider.example/v1")).toThrow(/不是有效地址/);
    expect(() => endpointFor("https://user:password@provider.example/v1")).toThrow(/不能包含用户名或密码/);
  });

  it("reports an unusable Base URL without sending a request", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const provider = new OpenAICompatibleProvider({
      enabled: true,
      provider: "custom",
      model: "test-model",
      baseUrl: "file:///etc/passwd",
      apiKey: "",
      timeoutMs: 5_000,
    });

    await expect(provider.chat([{ role: "user", content: "test" }])).rejects.toMatchObject({
      code: "AI_ERROR",
      message: "AI Base URL 只支持 http 或 https，当前是 file:",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
