import type { AppSettings, ConnectionTestResult } from "../../shared/schema.ts";
import { ConfuiError } from "../errors.ts";
import { readLimitedUtf8Response } from "../inference/limited-text.ts";

const MAX_PROVIDER_RESPONSE_BYTES = 2 * 1024 * 1024;

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  json?: boolean;
  temperature?: number;
  maxTokens?: number;
}

export interface AIProvider {
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<string>;
}

export class OpenAICompatibleProvider implements AIProvider {
  constructor(private readonly settings: AppSettings["ai"]) {}

  async chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<string> {
    if (!this.settings.baseUrl.trim()) throw new ConfuiError("AI_ERROR", "请先填写 AI Base URL");
    if (!this.settings.model.trim()) throw new ConfuiError("AI_ERROR", "请先填写 AI 模型名称");
    try {
      return await this.request(messages, options, options.json === true);
    } catch (error) {
      if (options.json && error instanceof ProviderHttpError && [400, 404, 422].includes(error.status)) {
        try {
          return await this.request(messages, options, false);
        } catch (fallbackError) {
          throw normalizeProviderError(fallbackError);
        }
      }
      throw normalizeProviderError(error);
    }
  }

  private async request(messages: ChatMessage[], options: ChatOptions, jsonMode: boolean): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), clampTimeout(this.settings.timeoutMs));
    const body: Record<string, unknown> = {
      model: this.settings.model.trim(),
      messages,
      temperature: options.temperature ?? 0.1,
      max_tokens: options.maxTokens ?? 2_500,
    };
    if (jsonMode) body.response_format = { type: "json_object" };
    try {
      const response = await fetch(endpointFor(this.settings.baseUrl), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          ...(this.settings.apiKey ? { Authorization: `Bearer ${this.settings.apiKey}` } : {}),
        },
        redirect: "error",
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const responseText = await readLimitedUtf8Response(response, {
        maxBytes: MAX_PROVIDER_RESPONSE_BYTES,
        overflow: "truncate",
      });
      if (!response.ok) throw new ProviderHttpError(response.status, responseText.slice(0, 800));
      let data: unknown;
      try {
        data = JSON.parse(responseText);
      } catch {
        throw new ConfuiError("AI_ERROR", "AI 服务返回的不是有效 JSON", responseText.slice(0, 300));
      }
      const content = readContent(data);
      if (!content) throw new ConfuiError("AI_ERROR", "AI 服务没有返回内容");
      return content;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export async function testAIConnection(settings: AppSettings["ai"]): Promise<ConnectionTestResult> {
  const started = performance.now();
  const provider = new OpenAICompatibleProvider(settings);
  const reply = await provider.chat([
    { role: "system", content: "Reply with exactly OK." },
    { role: "user", content: "Connection test" },
  ], { maxTokens: 8, temperature: 0 });
  return {
    latencyMs: Math.round(performance.now() - started),
    message: reply.trim().slice(0, 80) || "OK",
  };
}

/**
 * Resolves the chat endpoint, refusing anything that is not plain HTTP(S) —
 * `fetch` also speaks `file:` and `data:`, and a mistyped Base URL should fail
 * with a readable message rather than reach for something local.
 *
 * The check lives here rather than in `normalizeSettings` because that runs when
 * loading an existing settings file too: throwing there would lock the user out
 * of the very settings page that lets them correct the value.
 */
export function endpointFor(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl.trim());
  } catch {
    throw new ConfuiError("AI_ERROR", "AI Base URL 不是有效地址", baseUrl.trim().slice(0, 200));
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfuiError("AI_ERROR", `AI Base URL 只支持 http 或 https，当前是 ${url.protocol}`);
  }
  const pathname = url.pathname.replace(/\/+$/, "");
  url.pathname = /\/chat\/completions$/i.test(pathname)
    ? pathname
    : `${pathname}/chat/completions`;
  return url.href;
}

function clampTimeout(value: number): number {
  return Number.isFinite(value) ? Math.min(120_000, Math.max(5_000, value)) : 45_000;
}

function readContent(data: unknown): string {
  if (data === null || typeof data !== "object") return "";
  const choices = (data as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || !choices.length) return "";
  const first = choices[0];
  if (first === null || typeof first !== "object") return "";
  const message = (first as Record<string, unknown>).message;
  if (message === null || typeof message !== "object") return "";
  const content = (message as Record<string, unknown>).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => part !== null && typeof part === "object" && typeof (part as Record<string, unknown>).text === "string"
        ? String((part as Record<string, unknown>).text)
        : "")
      .join("");
  }
  return "";
}

class ProviderHttpError extends Error {
  constructor(public readonly status: number, public readonly body: string) {
    super(`HTTP ${status}`);
  }
}

function normalizeProviderError(error: unknown): ConfuiError {
  if (error instanceof ConfuiError) return error;
  if (error instanceof ProviderHttpError) {
    return new ConfuiError("AI_ERROR", `AI 服务返回 ${error.status}`, error.body);
  }
  const message = error instanceof Error && error.name === "AbortError"
    ? "AI 连接超时"
    : error instanceof Error
      ? error.message
      : String(error);
  return new ConfuiError("AI_ERROR", "无法连接 AI 服务", message);
}
