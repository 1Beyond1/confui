import type { ConfigFile, ConfigFormSchema, FieldSpec } from "../../../shared/schema.ts";
import type { AIProvider } from "./provider.ts";

const SYSTEM_PROMPT = `You are a configuration assistant. Given a JSON config file and optional README context, produce a form schema describing every user-configurable field. Infer types, required flags, defaults, and enums where possible. Mark credential fields (passwords, tokens, API keys) as secret. Write clear, short descriptions, preferring info from the README when available. Output STRICT JSON.`;

export async function inferSchemaWithAI(
  file: ConfigFile,
  jsonText: string,
  readmeContext: string,
  provider: AIProvider,
  model?: string
): Promise<ConfigFormSchema> {
  const userPrompt = `Config file path: ${file.path}
Detected kind: ${file.kind}

--- JSON content ---
${jsonText}
${readmeContext ? `\n--- README context ---\n${readmeContext}\n` : ""}
Return JSON with this exact shape:
{"fields":[{"path":"dotted.path","label":"Human Label","description":"...","type":"string|number|integer|boolean|enum|secret|color|object|array|json","required":false,"default":null,"enum":["a","b"],"secret":false,"group":"Section","properties":[...],"items":{...}}]}
Rules:
- "path" is the dotted path in the JSON object.
- For objects, recurse into "properties". For arrays, describe one item in "items".
- Omit properties/items/enum/default when not applicable.
- Keep descriptions to one sentence.`;

  const raw = await provider.chat(
    [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    { model, json: true, temperature: 0.1 }
  );

  let parsed: { fields?: FieldSpec[] };
  try {
    parsed = JSON.parse(raw);
  } catch {
    const m = raw.match(/\{[\s\S]*\}/);
    parsed = m ? JSON.parse(m[0]) : { fields: [] };
  }
  return {
    file: file.path,
    kind: file.kind,
    fields: parsed.fields ?? [],
    source: "ai",
    writable: true,
  };
}
