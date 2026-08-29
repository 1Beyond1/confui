import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { allowedSchemaUrl, inferJsonSchemaFields } from "../core/inference/json-schema.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const SCHEMA = {
  type: "object",
  properties: { port: { type: "integer", title: "端口", description: "监听端口" } },
};
const SCHEMA_MAX_BYTES = 2 * 1024 * 1024;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

async function projectWith(config: unknown): Promise<{ root: string; file: string }> {
  const root = await mkdtemp(join(tmpdir(), "confui-schema-"));
  temporaryDirectories.push(root);
  const file = join(root, "config.json");
  await writeFile(file, JSON.stringify(config));
  return { root, file };
}

describe("remote JSON Schema gating", () => {
  it("only accepts HTTPS URLs on allowlisted hosts", () => {
    expect(allowedSchemaUrl("https://json.schemastore.org/tsconfig.json"))
      .toBe("https://json.schemastore.org/tsconfig.json");
    expect(allowedSchemaUrl("https://raw.githubusercontent.com/o/r/main/s.json")).toBeDefined();
    // Plain HTTP lets anything on the path rewrite the form definition.
    expect(allowedSchemaUrl("http://json.schemastore.org/tsconfig.json")).toBeUndefined();
    expect(allowedSchemaUrl("https://attacker.example/probe.json")).toBeUndefined();
    // A lookalike host must not pass by suffix match.
    expect(allowedSchemaUrl("https://unpkg.com.attacker.example/x.json")).toBeUndefined();
    expect(allowedSchemaUrl("https://user:secret@json.schemastore.org/tsconfig.json")).toBeUndefined();
    expect(allowedSchemaUrl("not a url")).toBeUndefined();
  });

  it("never requests a schema from an untrusted host", async () => {
    const { root, file } = await projectWith({ $schema: "https://example.invalid/probe.json", port: 8080 });
    const fetcher = vi.fn<typeof fetch>();

    const result = await inferJsonSchemaFields(file, root, { $schema: "https://example.invalid/probe.json", port: 8080 }, fetcher);

    expect(fetcher).not.toHaveBeenCalled();
    expect(result.fields).toEqual([]);
    expect(result.warnings.join("\n")).toContain("example.invalid");
  });

  it("fetches an allowlisted schema and caches it for the next call", async () => {
    const url = "https://json.schemastore.org/confui-test.json";
    const { root, file } = await projectWith({ $schema: url, port: 8080 });
    const value = { $schema: url, port: 8080 };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(SCHEMA));

    const first = await inferJsonSchemaFields(file, root, value, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(url, expect.objectContaining({ redirect: "error" }));
    expect(first.warnings).toEqual([]);
    expect(first.fields.map((field) => field.label)).toEqual(["端口"]);

    await inferJsonSchemaFields(file, root, value, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("accepts a UTF-8 BOM in a remote schema", async () => {
    const url = "https://json.schemastore.org/confui-bom-test.json";
    const { root, file } = await projectWith({ $schema: url, port: 8080 });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(`\uFEFF${JSON.stringify(SCHEMA)}`, { status: 200 }),
    );

    const result = await inferJsonSchemaFields(file, root, { $schema: url, port: 8080 }, fetcher);

    expect(result.warnings).toEqual([]);
    expect(result.fields.map((field) => field.label)).toEqual(["端口"]);
  });

  it("does not cache a failed fetch", async () => {
    const url = "https://unpkg.com/confui-test/schema.json";
    const { root, file } = await projectWith({ $schema: url });
    const value = { $schema: url };
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("nope", { status: 503 }))
      .mockResolvedValueOnce(jsonResponse(SCHEMA));

    const failed = await inferJsonSchemaFields(file, root, value, fetcher);
    expect(failed.warnings.join("\n")).toContain("503");

    const retried = await inferJsonSchemaFields(file, root, value, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(retried.fields.map((field) => field.label)).toEqual(["端口"]);
  });

  it("rejects an oversized local schema without reading it as an unbounded string", async () => {
    const { root, file } = await projectWith({ $schema: "./oversized.schema.json", port: 8080 });
    await writeFile(join(root, "oversized.schema.json"), Buffer.alloc(SCHEMA_MAX_BYTES + 1, " "));

    const result = await inferJsonSchemaFields(
      file,
      root,
      { $schema: "./oversized.schema.json", port: 8080 },
    );

    expect(result.fields).toEqual([]);
    expect(result.warnings.join("\n")).toContain("Schema 超过 2 MiB");
  });

  it("accepts a UTF-8 BOM in a local schema", async () => {
    const { root, file } = await projectWith({ $schema: "./bom.schema.json", port: 8080 });
    await writeFile(join(root, "bom.schema.json"), `\uFEFF${JSON.stringify(SCHEMA)}`, "utf8");

    const result = await inferJsonSchemaFields(
      file,
      root,
      { $schema: "./bom.schema.json", port: 8080 },
    );

    expect(result.warnings).toEqual([]);
    expect(result.fields.map((field) => field.label)).toEqual(["端口"]);
  });

  it("rejects and cancels an oversized remote schema stream", async () => {
    const url = "https://json.schemastore.org/confui-oversized-stream-test.json";
    const { root, file } = await projectWith({ $schema: url });
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.alloc(SCHEMA_MAX_BYTES, " "));
        controller.enqueue(Buffer.from(" "));
      },
      cancel() {
        canceled = true;
      },
    });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(stream));

    const result = await inferJsonSchemaFields(file, root, { $schema: url }, fetcher);

    expect(result.fields).toEqual([]);
    expect(result.warnings.join("\n")).toContain("Schema 超过 2 MiB");
    expect(canceled).toBe(true);
  });
});
