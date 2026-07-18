import { describe, expect, it } from "vitest";
import { parseConfig, updateConfigText } from "../core/formats.ts";

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
});
