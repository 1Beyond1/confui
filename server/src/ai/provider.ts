import type { AppSettings } from "../../../shared/schema.ts";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AIProvider {
  id: string;
  chat(
    messages: ChatMessage[],
    opts?: { model?: string; json?: boolean; temperature?: number }
  ): Promise<string>;
}

/**
 * OpenAI-compatible provider. Works with official OpenAI AND any custom
 * OpenAI-compatible endpoint via baseUrl override:
 * OpenRouter, DeepSeek, Moonshot, Groq, Azure, local Ollama/llama.cpp, etc.
 * This is the single implementation backing the "custom provider" setting.
 */
export class OpenAICompatibleProvider implements AIProvider {
  id = "openai-compatible";
  constructor(private settings: AppSettings["ai"]) {}

  private get endpoint(): string {
    const base = (this.settings.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
    return `${base}/chat/completions`;
  }

  async chat(
    messages: ChatMessage[],
    opts: { model?: string; json?: boolean; temperature?: number } = {}
  ): Promise<string> {
    const model = opts.model || this.settings.model || "gpt-4o-mini";
    const body: Record<string, unknown> = {
      model,
      messages,
      temperature: opts.temperature ?? 0.2,
    };
    if (opts.json) body.response_format = { type: "json_object" };

    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.settings.apiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`AI provider error ${res.status}: ${text.slice(0, 500)}`);
    }
    const data = (await res.json()) as any;
    return data?.choices?.[0]?.message?.content ?? "";
  }
}

export function createProvider(settings: AppSettings["ai"]): AIProvider {
  return new OpenAICompatibleProvider(settings);
}
