import type { PathSegment } from "../../shared/schema.ts";
import { getAtPath } from "../paths.ts";
import type { FieldCandidate } from "./types.ts";

interface KnownDefinition {
  segments: PathSegment[];
  label: string;
  description: string;
  type?: FieldCandidate["type"];
  enum?: Array<string | number>;
  required?: boolean;
  group?: string;
}

const PACKAGE: KnownDefinition[] = [
  { segments: ["name"], label: "包名称", description: "发布到包管理器时使用的唯一名称。", type: "string", required: true, group: "基本信息" },
  { segments: ["version"], label: "版本", description: "遵循 SemVer 规范的软件包版本号。", type: "string", group: "基本信息" },
  { segments: ["description"], label: "简介", description: "在包管理器和搜索结果中展示的简短说明。", type: "string", group: "基本信息" },
  { segments: ["private"], label: "私有包", description: "启用后可防止这个包被意外发布。", type: "boolean", group: "发布" },
  { segments: ["type"], label: "模块类型", description: "决定 .js 文件按 ESM 还是 CommonJS 解释。", type: "enum", enum: ["module", "commonjs"], group: "运行方式" },
  { segments: ["main"], label: "主入口", description: "CommonJS 消费方加载包时使用的入口文件。", type: "string", group: "运行方式" },
  { segments: ["scripts"], label: "脚本", description: "可通过 npm run 执行的项目命令。", type: "json", group: "脚本与依赖" },
  { segments: ["dependencies"], label: "运行依赖", description: "应用运行时需要安装的依赖。", type: "json", group: "脚本与依赖" },
  { segments: ["devDependencies"], label: "开发依赖", description: "仅在开发和构建阶段使用的依赖。", type: "json", group: "脚本与依赖" },
];

const TSCONFIG: KnownDefinition[] = [
  { segments: ["compilerOptions", "target"], label: "JavaScript 目标版本", description: "TypeScript 输出代码所面向的 JavaScript 版本。", type: "enum", enum: ["ES5", "ES2015", "ES2017", "ES2019", "ES2020", "ES2021", "ES2022", "ESNext"], group: "编译器" },
  { segments: ["compilerOptions", "module"], label: "模块系统", description: "输出代码使用的模块格式。", type: "enum", enum: ["CommonJS", "ESNext", "Node16", "NodeNext", "Preserve"], group: "编译器" },
  { segments: ["compilerOptions", "moduleResolution"], label: "模块解析", description: "TypeScript 查找导入模块时采用的算法。", type: "enum", enum: ["node", "node16", "nodenext", "bundler", "classic"], group: "编译器" },
  { segments: ["compilerOptions", "strict"], label: "严格模式", description: "一次启用全部严格类型检查规则。", type: "boolean", group: "类型检查" },
  { segments: ["compilerOptions", "noImplicitAny"], label: "禁止隐式 any", description: "无法推断类型且会退化为 any 时报告错误。", type: "boolean", group: "类型检查" },
  { segments: ["compilerOptions", "skipLibCheck"], label: "跳过声明文件检查", description: "不检查依赖中的 .d.ts 文件，可缩短构建时间。", type: "boolean", group: "类型检查" },
  { segments: ["compilerOptions", "outDir"], label: "输出目录", description: "编译产物写入的目录。", type: "string", group: "输入与输出" },
  { segments: ["compilerOptions", "rootDir"], label: "源码目录", description: "项目源文件的根目录。", type: "string", group: "输入与输出" },
  { segments: ["compilerOptions", "sourceMap"], label: "生成 Source Map", description: "为输出文件生成调试映射。", type: "boolean", group: "输入与输出" },
  { segments: ["include"], label: "包含文件", description: "参与 TypeScript 编译的文件匹配规则。", type: "array", group: "文件范围" },
  { segments: ["exclude"], label: "排除文件", description: "从编译范围排除的文件匹配规则。", type: "array", group: "文件范围" },
];

const ESLINT: KnownDefinition[] = [
  { segments: ["root"], label: "配置根目录", description: "阻止 ESLint 继续向父目录查找配置。", type: "boolean", group: "常规" },
  { segments: ["parser"], label: "解析器", description: "ESLint 用来解析源代码的解析器包。", type: "string", group: "解析" },
  { segments: ["parserOptions", "sourceType"], label: "源码类型", description: "将源文件按脚本或 ES 模块解析。", type: "enum", enum: ["script", "module"], group: "解析" },
  { segments: ["env"], label: "运行环境", description: "为对应运行环境启用预定义全局变量。", type: "json", group: "环境" },
  { segments: ["rules"], label: "规则", description: "逐项配置 ESLint 规则及严重级别。", type: "json", group: "规则" },
];

const PRETTIER: KnownDefinition[] = [
  { segments: ["printWidth"], label: "每行宽度", description: "格式化时尝试换行的目标列数。", type: "integer", group: "排版" },
  { segments: ["tabWidth"], label: "缩进宽度", description: "每一级缩进使用的空格数。", type: "integer", group: "排版" },
  { segments: ["useTabs"], label: "使用 Tab", description: "使用制表符而不是空格进行缩进。", type: "boolean", group: "排版" },
  { segments: ["semi"], label: "保留分号", description: "在语句末尾添加分号。", type: "boolean", group: "语法" },
  { segments: ["singleQuote"], label: "使用单引号", description: "优先使用单引号而不是双引号。", type: "boolean", group: "语法" },
  { segments: ["trailingComma"], label: "尾随逗号", description: "控制多行结构中尾随逗号的使用范围。", type: "enum", enum: ["none", "es5", "all"], group: "语法" },
];

export function inferKnownFields(kind: string, value: unknown): FieldCandidate[] {
  const lower = kind.toLowerCase();
  const definitions = lower === "package.json"
    ? PACKAGE
    : lower === "tsconfig.json" || lower === "jsconfig.json"
      ? TSCONFIG
      : lower.includes("eslint")
        ? ESLINT
        : lower.includes("prettier")
          ? PRETTIER
          : [];

  return definitions
    .filter((definition) => definition.required || getAtPath(value, definition.segments) !== undefined)
    .map((definition, order) => ({
      ...definition,
      value: getAtPath(value, definition.segments),
      source: "known-template" as const,
      confidence: 0.97,
      detail: `Confui 内置的 ${kind} 字段知识`,
      order,
    }));
}
