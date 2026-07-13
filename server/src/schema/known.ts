import type { FieldSpec } from "../../../shared/schema.ts";

/** A template returns rich FieldSpec[] for a known config file's parsed JSON. */
type Template = (json: any) => FieldSpec[];

const b = (
  path: string,
  label: string,
  desc: string,
  type: FieldSpec["type"],
  json: any,
  extra: Partial<FieldSpec> = {}
): FieldSpec => ({
  path,
  label,
  description: desc,
  type,
  value: path.split(".").reduce((o, k) => (o == null ? o : o[k]), json),
  source: "known-template",
  ...extra,
});

export const KNOWN_TEMPLATES: Record<string, Template> = {
  "tsconfig.json": (json) => {
    const c = json?.compilerOptions ?? {};
    const opt = (k: string, label: string, desc: string, type: FieldSpec["type"] = "boolean", en?: string[]) =>
      b(`compilerOptions.${k}`, label, desc, type, json, { value: c[k], enum: en, group: "Compiler Options" });
    return [
      opt("target", "Target", "JS language target for emitted output.", "enum", ["ES3","ES5","ES6","ES2015","ES2016","ES2017","ES2018","ES2019","ES2020","ES2021","ES2022","ESNext"]),
      opt("module", "Module", "Module system for emitted code.", "enum", ["CommonJS","ESNext","UMD","AMD","System","NodeNext"]),
      opt("moduleResolution", "Module Resolution", "How modules get resolved.", "enum", ["node","node16","nodenext","bundler","classic"]),
      opt("strict", "Strict", "Enable all strict type-checking options."),
      opt("outDir", "Out Dir", "Redirect output structure to this directory.", "string"),
      opt("rootDir", "Root Dir", "Source root directory.", "string"),
      opt("sourceMap", "Source Map", "Generate .map files."),
      opt("jsx", "JSX", "JSX code generation.", "enum", ["preserve","react","react-jsx","react-jsxdev","react-native"]),
      opt("esModuleInterop", "ES Module Interop", "Allow default imports from CommonJS modules."),
      opt("skipLibCheck", "Skip Lib Check", "Skip type checking of declaration files."),
      opt("noImplicitAny", "No Implicit Any", "Error on implicitly-typed 'any'."),
    ];
  },

  "package.json": (json) => [
    b("name", "Name", "The package name. Required for publishing.", "string", json, { group: "Identity", required: true }),
    b("version", "Version", "Semver version string.", "string", json, { group: "Identity" }),
    b("description", "Description", "Short description shown in registries.", "string", json, { group: "Identity" }),
    b("license", "License", "SPDX license identifier.", "string", json, { group: "Identity" }),
    b("author", "Author", "Author name or object.", "string", json, { group: "Identity" }),
    b("private", "Private", "Prevent accidental publishing.", "boolean", json, { group: "Publish" }),
    b("type", "Module Type", "Package module system.", "enum", json, { enum: ["commonjs", "module"], group: "Publish" }),
  ],

  ".eslintrc.json": (json) => {
    const env = (k: string, label: string) =>
      b(`env.${k}`, label, `Globals for the ${label} environment.`, "boolean", json, { group: "Environments" });
    return [
      b("root", "Root", "Stop ESLint from looking for configs in parent dirs.", "boolean", json, { group: "General" }),
      b("parser", "Parser", "Parser to use.", "string", json, { group: "General" }),
      b("parserOptions.ecmaVersion", "ECMA Version", "ECMAScript version.", "enum", json, { enum: [3, 5, 6, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, "latest"], group: "Parser Options" }),
      b("parserOptions.sourceType", "Source Type", "Module or script.", "enum", json, { enum: ["script", "module"], group: "Parser Options" }),
      env("browser", "Browser"),
      env("node", "Node"),
      env("es2021", "ES2021"),
    ];
  },
};
