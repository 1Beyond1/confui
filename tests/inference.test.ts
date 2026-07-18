import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { inferConfig } from "../core/inference/index.ts";
import { findExampleFiles } from "../core/inference/examples.ts";
import { maskDocumentSecrets, maskSecrets } from "../core/inference/heuristic.ts";
import { parseReadme } from "../core/inference/readme.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("inference pipeline", () => {
  it("merges schema type, README description, sample default and current value per property", async () => {
    const root = await mkdtemp(join(tmpdir(), "confui-infer-"));
    temporaryDirectories.push(root);
    await Promise.all([
      writeFile(join(root, "config.json"), `{
  // current project value
  "server": { "port": 3000 },
  "apiKey": "live-secret"
}\n`),
      writeFile(join(root, "schema.json"), JSON.stringify({
        type: "object",
        properties: {
          server: {
            type: "object",
            properties: { port: { type: "integer", minimum: 1, maximum: 65535 } },
            required: ["port"],
          },
          apiKey: { type: "string", writeOnly: true },
        },
      })),
      writeFile(join(root, "config.example.json"), JSON.stringify({
        server: { port: 8080 },
        featureFlag: "<true-or-false>",
      })),
      writeFile(join(root, "config.json.example"), JSON.stringify({ logLevel: "info" })),
      writeFile(join(root, "README.md"), `# Demo

| Field | Description | Default |
| --- | --- | --- |
| server.port | HTTP 服务监听端口 | 4000 |
| apiKey | 服务访问密钥 | - |
`),
    ]);

    expect((await findExampleFiles(join(root, "config.json"))).map((path) => path.split(/[\\/]/).at(-1))).toEqual([
      "config.example.json",
      "config.json.example",
    ]);

    const schema = await inferConfig(root, "config.json");
    const port = schema.fields.find((field) => field.path === "server.port");
    expect(port).toMatchObject({
      value: 3000,
      default: 8080,
      description: "HTTP 服务监听端口",
      type: "integer",
      required: true,
      minimum: 1,
      maximum: 65535,
    });
    expect(port?.evidence.find((item) => item.property === "type")?.source).toBe("json-schema");
    expect(port?.evidence.find((item) => item.property === "description")?.source).toBe("readme");
    expect(port?.evidence.find((item) => item.property === "default")?.source).toBe("example");
    expect(schema.fields.find((field) => field.path === "featureFlag")?.required).toBe(true);
    expect(schema.fields.find((field) => field.path === "apiKey")?.type).toBe("secret");
    expect(schema.readmeSource).toBe("local");
    expect(schema.exampleFiles).toHaveLength(2);
  });

  it("masks secrets recursively before AI context is created", () => {
    expect(maskSecrets({ token: "abc", authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.payload", nested: { password: "def", safe: "ok" }, items: [{ apiKey: "ghi" }] })).toEqual({
      token: "***",
      authorization: "***",
      nested: { password: "***", safe: "ok" },
      items: [{ apiKey: "***" }],
    });
    expect(maskDocumentSecrets("API_KEY=sk-abcdefghijklmnop\ntoken: ghp_abcdefghijklmnop")).toBe(
      "API_KEY=***\ntoken: ***",
    );
    expect(maskDocumentSecrets([
      '{"apiKey": "live-secret", "safe": "keep"}',
      "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature",
      'curl -H "Authorization: Bearer abcDEF_123-xyz"',
    ].join("\n"))).toBe([
      '{"apiKey": "***", "safe": "keep"}',
      "Authorization: Bearer ***",
      'curl -H "Authorization: Bearer ***"',
    ].join("\n"));
  });

  it("does not attach an ambiguous README leaf name to the wrong nested field", () => {
    const fields = parseReadme(
      "- `port`: generic port\n- `server.port`: server port",
      [["server", "port"], ["database", "port"]],
      "json",
    );
    expect(fields).toHaveLength(1);
    expect(fields[0]?.segments).toEqual(["server", "port"]);
  });

  it("asks AI only about fields that stronger sources still do not describe", async () => {
    const root = await mkdtemp(join(tmpdir(), "confui-ai-fallback-"));
    temporaryDirectories.push(root);
    await Promise.all([
      writeFile(join(root, "config.json"), JSON.stringify({ documented: true, unknown: false, apiToken: "private", sessionKey: "private" })),
      writeFile(join(root, "config.schema.json"), JSON.stringify({
        type: "object",
        properties: {
          documented: { type: "boolean", description: "Schema already explains this field." },
          unknown: { type: "boolean" },
          apiToken: { type: "string" },
          sessionKey: { type: "string" },
        },
      })),
    ]);
    const prompts: string[] = [];
    const schema = await inferConfig(root, "config.json", {
      ai: {
        async chat(messages) {
          prompts.push(messages.at(-1)?.content ?? "");
          return JSON.stringify({ fields: [
            { path: "unknown", description: "由 AI 补充的说明。" },
            { path: "apiToken", description: "访问令牌。", type: "string", secret: false },
            { path: "sessionKey", description: "会话密钥。", type: "string", secret: true },
          ] });
        },
      },
    });

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('可用字段路径：["unknown","apiToken","sessionKey"]');
    expect(schema.fields.find((field) => field.path === "documented")?.description).toBe("Schema already explains this field.");
    expect(schema.fields.find((field) => field.path === "unknown")?.description).toBe("由 AI 补充的说明。");
    expect(schema.fields.find((field) => field.path === "apiToken")).toMatchObject({ type: "secret", secret: true });
    expect(schema.fields.find((field) => field.path === "sessionKey")).toMatchObject({ type: "secret", secret: true });
  });
});
