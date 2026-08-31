import { describe, expect, it } from "vitest";
import { assertEditableSyntax, looksLikeIni, parseConfig, updateConfigText } from "../core/formats.ts";

const NGINX_CONF = `user nginx;
worker_processes auto;

http {
    server {
        listen 80;
        server_name example.com;
    }
}
`;

describe("configuration formats", () => {
  it("applies nested JSONC edits while preserving comments, trailing commas and indentation", () => {
    const original = `{
  // server settings
  "server": {
    "port": 3000,
    "host": "127.0.0.1",
  },
  "enabled": true,
}
`;
    const { output } = updateConfigText(original, "jsonc", [
      { segments: ["server", "port"], value: 8080 },
      { segments: ["server", "host"], value: "0.0.0.0" },
      { segments: ["enabled"], value: false },
    ]);

    expect(output).toContain("// server settings");
    expect(output).toContain('"port": 8080');
    expect(output).toContain('"host": "0.0.0.0"');
    expect(output).toMatch(/"enabled": false,\s*\n}/);
    expect(parseConfig(output, "jsonc")).toEqual({
      server: { port: 8080, host: "0.0.0.0" },
      enabled: false,
    });
  });

  it("preserves env comments, export syntax and quoting", () => {
    const original = `# connection
export API_URL="http://localhost:3000"
TOKEN=old # keep this note
LABEL='old' # keep quote safely
`;
    const { output } = updateConfigText(original, "env", [
      { segments: ["API_URL"], value: "https://example.com/api v2" },
      { segments: ["TOKEN"], value: "new#token" },
      { segments: ["LABEL"], value: "it's ready" },
    ]);
    expect(output).toContain("# connection");
    expect(output).toContain('export API_URL="https://example.com/api v2"');
    expect(output).toContain('TOKEN="new#token" # keep this note');
    expect(output).toContain('LABEL="it\'s ready" # keep quote safely');
    expect(parseConfig(output, "env")).toEqual({
      API_URL: "https://example.com/api v2",
      TOKEN: "new#token",
      LABEL: "it's ready",
    });

    const multiline = updateConfigText("LABEL='old'\n", "env", [
      { segments: ["LABEL"], value: "first\nsecond" },
    ]).output;
    expect(multiline).toContain('LABEL="first\\nsecond"');
    expect(parseConfig(multiline, "env")).toEqual({ LABEL: "first\nsecond" });
  });

  it("removes JSON and JSONC properties when a field is reset", () => {
    const json = updateConfigText('{\n  "keep": true,\n  "remove": 1\n}\n', "json", [
      { segments: ["remove"], value: undefined },
    ]).output;
    expect(parseConfig(json, "json")).toEqual({ keep: true });

    const jsonc = updateConfigText('{\n  // keep comment\n  "keep": true,\n  "remove": 1,\n}\n', "jsonc", [
      { segments: ["remove"], value: undefined },
    ]).output;
    expect(jsonc).toContain("// keep comment");
    expect(parseConfig(jsonc, "jsonc")).toEqual({ keep: true });
  });

  it("removes flat assignments when a field is reset to unset", () => {
    const env = "# keep\nFLAG=true\nOTHER=value\n";
    const envOutput = updateConfigText(env, "env", [{ segments: ["FLAG"], value: undefined }]).output;
    expect(envOutput).toBe("# keep\nOTHER=value\n");
    expect(parseConfig(envOutput, "env")).toEqual({ OTHER: "value" });

    const ini = "[app]\n; keep\nflag=true\nother=value\n";
    const iniOutput = updateConfigText(ini, "ini", [{ segments: ["app", "flag"], value: undefined }]).output;
    expect(iniOutput).toBe("[app]\n; keep\nother=value\n");
    expect(parseConfig(iniOutput, "ini")).toEqual({ app: { other: "value" } });

    const properties = String.raw`app.path=/first \
  /second
app.name=Confui
`;
    const propertiesOutput = updateConfigText(properties, "properties", [{ segments: ["app.path"], value: undefined }]).output;
    expect(propertiesOutput).toBe("app.name=Confui\n");
    expect(parseConfig(propertiesOutput, "properties")).toEqual({ "app.name": "Confui" });
  });

  it("removes YAML and TOML properties when a field is reset to unset", () => {
    const yaml = "server:\n  enabled: true\n  port: 3000\n";
    const yamlOutput = updateConfigText(yaml, "yaml", [{ segments: ["server", "enabled"], value: undefined }]).output;
    expect(parseConfig(yamlOutput, "yaml")).toEqual({ server: { port: 3000 } });

    const toml = "[server]\nenabled = true\nport = 3000\n";
    const tomlOutput = updateConfigText(toml, "toml", [{ segments: ["server", "enabled"], value: undefined }]).output;
    expect(parseConfig(tomlOutput, "toml")).toMatchObject({ server: { port: 3000 } });
  });

  it("preserves UTF-8 BOMs and does not drop unknown env escapes", () => {
    const json = '\uFEFF{\n  "port": 3000\n}\n';
    const updatedJson = updateConfigText(json, "json", [{ segments: ["port"], value: 8080 }]).output;
    expect(updatedJson.startsWith("\uFEFF")).toBe(true);
    expect(parseConfig(updatedJson, "json")).toEqual({ port: 8080 });

    const env = String.raw`WINDOWS_PATH="C:\Program Files\Confui"
MULTILINE="first\nsecond\tvalue"
`;
    expect(parseConfig(env, "env")).toEqual({
      WINDOWS_PATH: String.raw`C:\Program Files\Confui`,
      MULTILINE: "first\nsecond\tvalue",
    });
  });

  it("rejects duplicate JSON keys without confusing identical nested leaf names", () => {
    try {
      parseConfig('{"port": 3000, "port": 8080}', "json");
      throw new Error("expected duplicate keys to be rejected");
    } catch (error) {
      expect(error).toMatchObject({
        code: "PARSE_ERROR",
        detail: expect.stringContaining("重复"),
      });
    }
    expect(parseConfig('{"http":{"port":80},"https":{"port":443}}', "json")).toEqual({
      http: { port: 80 },
      https: { port: 443 },
    });
  });

  it("updates INI and properties files without dropping nearby comments", () => {
    const ini = `; database
[database]
host=localhost
port=5432 ; keep port note
password=old
[service.cache]
path=old
`;
    const iniOutput = updateConfigText(ini, "ini", [
      { segments: ["database", "port"], value: 6432 },
      { segments: ["database", "password"], value: "a;b#c" },
      { segments: ["service", "cache", "path"], value: "new-path" },
      { segments: ["mode"], value: "production" },
    ]).output;
    expect(iniOutput).toContain("; database");
    expect(iniOutput).toContain("port=6432 ; keep port note");
    expect(iniOutput).toContain("password=a\\;b\\#c");
    expect(iniOutput.indexOf("mode=production")).toBeLessThan(iniOutput.indexOf("[database]"));
    expect(parseConfig(iniOutput, "ini")).toMatchObject({
      mode: "production",
      database: { port: "6432", password: "a;b#c" },
      service: { cache: { path: "new-path" } },
    });

    const properties = `# application
app.name=Confui
app\\:mode=dev
`;
    const propertiesOutput = updateConfigText(properties, "properties", [
      { segments: ["app.name"], value: "Confui Desktop" },
      { segments: ["app:mode"], value: "prod" },
      { segments: ["new key"], value: " leading" },
    ]).output;
    expect(propertiesOutput).toContain("# application");
    expect(propertiesOutput).toContain("app.name=Confui Desktop");
    expect(propertiesOutput).toContain("app\\:mode=prod");
    expect(propertiesOutput).toContain("new\\ key=\\ leading");
    expect(parseConfig(propertiesOutput, "properties")).toMatchObject({ "new key": " leading" });
  });

  it("refuses to treat a directive-style .conf as INI", () => {
    expect(looksLikeIni(NGINX_CONF)).toBe(false);
    expect(looksLikeIni("[core]\n\trepositoryformatversion = 0\n")).toBe(true);
    expect(looksLikeIni("; only comments\n")).toBe(true);

    expect(() => assertEditableSyntax("nginx.conf", NGINX_CONF)).toThrow(/不是 INI 语法/);
    // A real INI keeps working, and the .ini extension is trusted outright.
    expect(() => assertEditableSyntax("app.cfg", "[a]\nb=1\n")).not.toThrow();
    expect(() => assertEditableSyntax("app.cfg", "[a]\nname: value\n")).not.toThrow();
    expect(() => assertEditableSyntax("odd.ini", NGINX_CONF)).not.toThrow();
  });

  it("rejects a save it cannot apply in place instead of appending a stray line", () => {
    // `ini.parse` turns every nginx directive into a boolean key, so the field
    // exists in the parsed document but no `key=value` line backs it.
    expect(parseConfig(NGINX_CONF, "ini")).toMatchObject({ "listen 80": true });
    expect(() => updateConfigText(NGINX_CONF, "ini", [{ segments: ["listen 80"], value: false }]))
      .toThrow(/无法在原文件中定位/);

    const properties = "app.name=Confui\n";
    expect(() => updateConfigText(properties, "properties", [{ segments: ["app.name"], value: "x" }]))
      .not.toThrow();
  });

  it("replaces a whole properties continuation instead of orphaning its tail", () => {
    const original = `# paths
app.path=/first \\
    /second
app.name=Confui
`;
    expect(parseConfig(original, "properties")).toMatchObject({ "app.path": "/first /second" });

    const { output } = updateConfigText(original, "properties", [
      { segments: ["app.path"], value: "/only" },
    ]);
    expect(output).toContain("# paths");
    expect(output).not.toContain("/second");
    expect(parseConfig(output, "properties")).toEqual({
      "app.path": "/only",
      "app.name": "Confui",
    });
  });

  it("round-trips YAML and TOML values and reports formatting risk", () => {
    const yaml = `server:\n  port: 3000\n`;
    const yamlResult = updateConfigText(yaml, "yaml", [{ segments: ["server", "port"], value: 8080 }]);
    expect(parseConfig(yamlResult.output, "yaml")).toEqual({ server: { port: 8080 } });
    expect(yamlResult.warnings[0]).toContain("注释");

    const toml = `[server]\nport = 3000\n`;
    const tomlResult = updateConfigText(toml, "toml", [{ segments: ["server", "port"], value: 8080 }]);
    expect(parseConfig(tomlResult.output, "toml")).toMatchObject({ server: { port: 8080 } });
    expect(tomlResult.warnings[0]).toContain("TOML");
  });

  it("preserves TOML date metadata when an unrelated value changes", () => {
    const original = "date = 2026-08-31T12:34:56+08:00\nport = 3000\n";
    const { output } = updateConfigText(original, "toml", [
      { segments: ["port"], value: 8080 },
    ]);

    const parsed = parseConfig(output, "toml") as { date: Date; port: number };
    expect(parsed.date).toBeInstanceOf(Date);
    expect(parsed.date.toISOString()).toBe("2026-08-31T12:34:56.000+08:00");
    expect(parsed.port).toBe(8080);
  });

  it("keeps valid TOML integers beyond JavaScript's safe range editable", () => {
    const original = "requestId = 9223372036854775807\nport = 3000\n";
    expect(parseConfig(original, "toml")).toMatchObject({ requestId: 9223372036854775807n });

    const updated = updateConfigText(original, "toml", [
      { segments: ["requestId"], value: "9223372036854775806" },
      { segments: ["port"], value: 8080 },
    ]).output;
    const parsed = parseConfig(updated, "toml") as { requestId: bigint; port: number };
    expect(parsed.requestId).toBe(9223372036854775806n);
    expect(parsed.port).toBe(8080);
  });

  it("accepts TOML hexadecimal, octal and binary big integers", () => {
    const binaryLiteral = `0b1_${"0".repeat(63)}`;
    const original = `hex = 0xFFFF_FFFF_FFFF_FFFF\noctal = 0o1777777777777777777777\nbinary = ${binaryLiteral}\n`;
    const output = updateConfigText(original, "toml", [
      { segments: ["hex"], value: "-0x8000_0000_0000_0000" },
      { segments: ["octal"], value: "+0o1777777777777777777777" },
      { segments: ["binary"], value: binaryLiteral },
    ]).output;
    const parsed = parseConfig(output, "toml") as Record<string, unknown>;

    expect(parsed.hex).toBe(-0x8000000000000000n);
    expect(parsed.octal).toBe(18446744073709551615n);
    expect(parsed.binary).toBe(1n << 63n);
  });

  it("keeps TOML special floating-point values editable", () => {
    const original = "positive = inf\nnegative = -inf\nunknown = nan\nport = 3000\n";
    const parsed = parseConfig(original, "toml") as Record<string, unknown>;
    expect(parsed.positive).toBe(Infinity);
    expect(parsed.negative).toBe(-Infinity);
    expect(Number.isNaN(parsed.unknown as number)).toBe(true);

    const { output } = updateConfigText(original, "toml", [
      { segments: ["positive"], value: "-inf" },
      { segments: ["port"], value: 8080 },
    ]);
    const updated = parseConfig(output, "toml") as Record<string, unknown>;
    expect(updated.positive).toBe(-Infinity);
    expect(updated.negative).toBe(-Infinity);
    expect(Number.isNaN(updated.unknown as number)).toBe(true);
    expect(updated.port).toBe(8080);
  });

  it("preserves parser-specific TOML values when editing an array field", () => {
    const original = "requestIds = [9223372036854775807, 9223372036854775806]\nratios = [inf, -inf]\n";
    const { output } = updateConfigText(original, "toml", [
      { segments: ["requestIds"], value: ["9223372036854775805", "9223372036854775804"] },
      { segments: ["ratios"], value: ["-inf", "inf"] },
    ]);
    const parsed = parseConfig(output, "toml") as { requestIds: bigint[]; ratios: number[] };
    expect(parsed.requestIds).toEqual([9223372036854775805n, 9223372036854775804n]);
    expect(parsed.ratios).toEqual([-Infinity, Infinity]);

    const appended = updateConfigText("requestIds = [9223372036854775807]\n", "toml", [
      { segments: ["requestIds"], value: ["9223372036854775807", "9223372036854775806"] },
    ]).output;
    expect(parseConfig(appended, "toml")).toMatchObject({
      requestIds: [9223372036854775807n, 9223372036854775806n],
    });

    const appendedSpecial = updateConfigText("ratios = [inf]\n", "toml", [
      { segments: ["ratios"], value: ["inf", "-inf"] },
    ]).output;
    expect(parseConfig(appendedSpecial, "toml")).toMatchObject({ ratios: [Infinity, -Infinity] });
  });

  it("updates and removes bracketed INI arrays without leaving stale entries", () => {
    const original = "[app]\ntags[]=one\ntags[]=two\n";
    const updated = updateConfigText(original, "ini", [
      { segments: ["app", "tags"], value: ["three", "four"] },
    ]).output;

    expect(updated).toContain("tags[]=three");
    expect(updated).toContain("tags[]=four");
    expect(updated).not.toContain("tags[]=one");
    expect(parseConfig(updated, "ini")).toEqual({ app: { tags: ["three", "four"] } });

    const removed = updateConfigText(updated, "ini", [
      { segments: ["app", "tags"], value: undefined },
    ]).output;
    expect(removed).not.toContain("tags[]=");
    expect(parseConfig(removed, "ini")).toEqual({ app: {} });
  });

  it("keeps INI strings that look like parser literals as strings", () => {
    const original = "name=old\n";
    const output = updateConfigText(original, "ini", [
      { segments: ["name"], value: "true" },
    ]).output;

    expect(output).toContain('name="true"');
    expect(parseConfig(output, "ini")).toEqual({ name: "true" });
  });

  it("updates INI files that use the supported colon separator", () => {
    const original = "[app]\nname: old\nflag: true\ntags[]: one\ntags[]: two\n";
    const output = updateConfigText(original, "ini", [
      { segments: ["app", "name"], value: "new" },
      { segments: ["app", "flag"], value: false },
      { segments: ["app", "tags"], value: ["three", "four"] },
    ]).output;

    expect(output).toContain("name: new");
    expect(output).toContain("flag: false");
    expect(output).toContain("tags[]: three");
    expect(output).toContain("tags[]: four");
    expect(parseConfig(output, "ini")).toEqual({ app: { name: "new", flag: false, tags: ["three", "four"] } });
  });

  it("does not mistake an escaped colon in an INI key for the separator", () => {
    const original = "literal\\:key=old\n";
    const output = updateConfigText(original, "ini", [
      { segments: ["literal\\:key"], value: "new" },
    ]).output;

    expect(output).toBe("literal\\:key=new\n");
    expect(parseConfig(output, "ini")).toEqual({ "literal\\:key": "new" });
  });

  it("rejects complex values for flat configuration formats", () => {
    expect(() => updateConfigText("KEY=old\n", "env", [
      { segments: ["KEY"], value: { nested: true } },
    ])).toThrow(/只支持标量键值/);
    expect(() => updateConfigText("key=old\n", "properties", [
      { segments: ["key"], value: ["one", "two"] },
    ])).toThrow(/只支持标量键值/);
  });

  it("does not silently drop an empty INI array", () => {
    expect(() => updateConfigText("[app]\ntags[]=one\n", "ini", [
      { segments: ["app", "tags"], value: [] },
    ])).toThrow(/标量数组/);
  });

  it("accepts shared YAML aliases but refuses cyclic aliases", () => {
    expect(parseConfig("defaults: &defaults\n  enabled: true\none: *defaults\ntwo: *defaults\n", "yaml"))
      .toMatchObject({ one: { enabled: true }, two: { enabled: true } });
    expect(() => parseConfig("self: &self\n  child: *self\n", "yaml"))
      .toThrow(/循环引用/);
  });
});
