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

  it("accepts shared YAML aliases but refuses cyclic aliases", () => {
    expect(parseConfig("defaults: &defaults\n  enabled: true\none: *defaults\ntwo: *defaults\n", "yaml"))
      .toMatchObject({ one: { enabled: true }, two: { enabled: true } });
    expect(() => parseConfig("self: &self\n  child: *self\n", "yaml"))
      .toThrow(/循环引用/);
  });
});
