import type { ConfigFormat, ItemFieldSpec, Locale, PathSegment } from "../../shared/schema.ts";
import { getAtPath } from "../paths.ts";
import type { FieldCandidate } from "./types.ts";

interface BilingualText {
  zh: string;
  en: string;
}

interface KnownItemFieldDef {
  key: string;
  label: BilingualText;
  description: BilingualText;
  type: FieldCandidate["type"];
  required?: boolean;
  enum?: Array<string | number>;
  minimum?: number;
  maximum?: number;
}

interface KnownDefinition {
  segments: PathSegment[];
  label: BilingualText;
  description: BilingualText;
  type?: FieldCandidate["type"];
  enum?: Array<string | number>;
  minimum?: number;
  maximum?: number;
  required?: boolean;
  secret?: boolean;
  placeholder?: string;
  group?: BilingualText;
  itemFields?: KnownItemFieldDef[];
}

const PACKAGE: KnownDefinition[] = [
  { segments: ["name"], label: { zh: "包名称", en: "Package Name" }, description: { zh: "发布到包管理器时使用的唯一名称。", en: "Unique package identifier used by npm and registries." }, type: "string", required: true, group: { zh: "基本信息", en: "General" } },
  { segments: ["version"], label: { zh: "版本", en: "Version" }, description: { zh: "遵循 SemVer 规范的软件包版本号。", en: "Semantic version (SemVer) of the package." }, type: "string", group: { zh: "基本信息", en: "General" } },
  { segments: ["description"], label: { zh: "简介", en: "Description" }, description: { zh: "在包管理器和搜索结果中展示的简短说明。", en: "Short summary shown in registries and search results." }, type: "string", group: { zh: "基本信息", en: "General" } },
  { segments: ["private"], label: { zh: "私有包", en: "Private" }, description: { zh: "启用后可防止这个包被意外发布。", en: "Prevents accidental publishing to a public registry." }, type: "boolean", group: { zh: "发布", en: "Publishing" } },
  { segments: ["type"], label: { zh: "模块类型", en: "Module Type" }, description: { zh: "决定 .js 文件按 ESM 还是 CommonJS 解释。", en: "Determines whether .js files are treated as ES modules or CommonJS." }, type: "enum", enum: ["module", "commonjs"], group: { zh: "运行方式", en: "Runtime" } },
  { segments: ["main"], label: { zh: "主入口", en: "Main Entry" }, description: { zh: "CommonJS 消费方加载包时使用的入口文件。", en: "Primary entry point loaded by CommonJS consumers." }, type: "string", group: { zh: "运行方式", en: "Runtime" } },
  { segments: ["scripts"], label: { zh: "脚本", en: "Scripts" }, description: { zh: "可通过 npm run 执行的项目命令。", en: "Project commands runnable via npm run." }, type: "json", group: { zh: "脚本与依赖", en: "Scripts & Dependencies" } },
  { segments: ["dependencies"], label: { zh: "运行依赖", en: "Dependencies" }, description: { zh: "应用运行时需要安装的依赖。", en: "Packages required at runtime." }, type: "json", group: { zh: "脚本与依赖", en: "Scripts & Dependencies" } },
  { segments: ["devDependencies"], label: { zh: "开发依赖", en: "Dev Dependencies" }, description: { zh: "仅在开发和构建阶段使用的依赖。", en: "Packages only required for development, testing, or building." }, type: "json", group: { zh: "脚本与依赖", en: "Scripts & Dependencies" } },
];

const TSCONFIG: KnownDefinition[] = [
  { segments: ["compilerOptions", "target"], label: { zh: "JavaScript 目标版本", en: "JavaScript Target" }, description: { zh: "TypeScript 输出代码所面向的 JavaScript 版本。", en: "ECMAScript target version for emitted JavaScript." }, type: "enum", enum: ["ES5", "ES2015", "ES2017", "ES2019", "ES2020", "ES2021", "ES2022", "ESNext"], group: { zh: "编译器", en: "Compiler" } },
  { segments: ["compilerOptions", "module"], label: { zh: "模块系统", en: "Module System" }, description: { zh: "输出代码使用的模块格式。", en: "Module code generation format." }, type: "enum", enum: ["CommonJS", "ESNext", "Node16", "NodeNext", "Preserve"], group: { zh: "编译器", en: "Compiler" } },
  { segments: ["compilerOptions", "moduleResolution"], label: { zh: "模块解析", en: "Module Resolution" }, description: { zh: "TypeScript 查找导入模块时采用的算法。", en: "Strategy used to resolve imported modules." }, type: "enum", enum: ["node", "node16", "nodenext", "bundler", "classic"], group: { zh: "编译器", en: "Compiler" } },
  { segments: ["compilerOptions", "strict"], label: { zh: "严格模式", en: "Strict Mode" }, description: { zh: "一次启用全部严格类型检查规则。", en: "Enables all strict type-checking options at once." }, type: "boolean", group: { zh: "类型检查", en: "Type Checking" } },
  { segments: ["compilerOptions", "noImplicitAny"], label: { zh: "禁止隐式 any", en: "No Implicit Any" }, description: { zh: "无法推断类型且会退化为 any 时报告错误。", en: "Report errors on expressions and declarations with an implied any type." }, type: "boolean", group: { zh: "类型检查", en: "Type Checking" } },
  { segments: ["compilerOptions", "skipLibCheck"], label: { zh: "跳过声明文件检查", en: "Skip Lib Check" }, description: { zh: "不检查依赖中的 .d.ts 文件，可缩短构建时间。", en: "Skip type checking of declaration (.d.ts) files for faster builds." }, type: "boolean", group: { zh: "类型检查", en: "Type Checking" } },
  { segments: ["compilerOptions", "outDir"], label: { zh: "输出目录", en: "Output Directory" }, description: { zh: "编译产物写入的目录。", en: "Destination directory for emitted compiled files." }, type: "string", group: { zh: "输入与输出", en: "Input & Output" } },
  { segments: ["compilerOptions", "rootDir"], label: { zh: "源码目录", en: "Root Directory" }, description: { zh: "项目源文件的根目录。", en: "Root directory of TypeScript input files." }, type: "string", group: { zh: "输入与输出", en: "Input & Output" } },
  { segments: ["compilerOptions", "sourceMap"], label: { zh: "生成 Source Map", en: "Source Maps" }, description: { zh: "为输出文件生成调试映射。", en: "Generate source map files for debugging emitted JavaScript." }, type: "boolean", group: { zh: "输入与输出", en: "Input & Output" } },
  { segments: ["include"], label: { zh: "包含文件", en: "Include Patterns" }, description: { zh: "参与 TypeScript 编译的文件匹配规则。", en: "Glob patterns specifying files to include in compilation." }, type: "array", group: { zh: "文件范围", en: "File Scope" } },
  { segments: ["exclude"], label: { zh: "排除文件", en: "Exclude Patterns" }, description: { zh: "从编译范围排除的文件匹配规则。", en: "Glob patterns specifying files to exclude from compilation." }, type: "array", group: { zh: "文件范围", en: "File Scope" } },
];

const ESLINT: KnownDefinition[] = [
  { segments: ["root"], label: { zh: "配置根目录", en: "Config Root" }, description: { zh: "阻止 ESLint 继续向父目录查找配置。", en: "Stop ESLint from looking for configuration in parent directories." }, type: "boolean", group: { zh: "常规", en: "General" } },
  { segments: ["parser"], label: { zh: "解析器", en: "Parser" }, description: { zh: "ESLint 用来解析源代码的解析器包。", en: "Parser package used by ESLint to parse source code." }, type: "string", group: { zh: "解析", en: "Parsing" } },
  { segments: ["parserOptions", "sourceType"], label: { zh: "源码类型", en: "Source Type" }, description: { zh: "将源文件按脚本或 ES 模块解析。", en: "Parse source files as scripts or ES modules." }, type: "enum", enum: ["script", "module"], group: { zh: "解析", en: "Parsing" } },
  { segments: ["env"], label: { zh: "运行环境", en: "Environments" }, description: { zh: "为对应运行环境启用预定义全局变量。", en: "Predefined global variables for target runtime environments." }, type: "json", group: { zh: "环境", en: "Environment" } },
  { segments: ["rules"], label: { zh: "规则", en: "Rules" }, description: { zh: "逐项配置 ESLint 规则及严重级别。", en: "Configure individual ESLint rules and severity levels." }, type: "json", group: { zh: "规则", en: "Rules" } },
];

const PRETTIER: KnownDefinition[] = [
  { segments: ["printWidth"], label: { zh: "每行宽度", en: "Print Width" }, description: { zh: "格式化时尝试换行的目标列数。", en: "Target line length where Prettier wraps code." }, type: "integer", minimum: 40, maximum: 240, group: { zh: "排版", en: "Formatting" } },
  { segments: ["tabWidth"], label: { zh: "缩进宽度", en: "Tab Width" }, description: { zh: "每一级缩进使用的空格数。", en: "Number of spaces per indentation level." }, type: "integer", minimum: 1, maximum: 16, group: { zh: "排版", en: "Formatting" } },
  { segments: ["useTabs"], label: { zh: "使用 Tab", en: "Use Tabs" }, description: { zh: "使用制表符而不是空格进行缩进。", en: "Indent lines with tabs instead of spaces." }, type: "boolean", group: { zh: "排版", en: "Formatting" } },
  { segments: ["semi"], label: { zh: "保留分号", en: "Semicolons" }, description: { zh: "在语句末尾添加分号。", en: "Print semicolons at the ends of statements." }, type: "boolean", group: { zh: "语法", en: "Syntax" } },
  { segments: ["singleQuote"], label: { zh: "使用单引号", en: "Single Quote" }, description: { zh: "优先使用单引号而不是双引号。", en: "Use single quotes instead of double quotes." }, type: "boolean", group: { zh: "语法", en: "Syntax" } },
  { segments: ["trailingComma"], label: { zh: "尾随逗号", en: "Trailing Comma" }, description: { zh: "控制多行结构中尾随逗号的使用范围。", en: "Controls trailing commas in multi-line comma-separated constructs." }, type: "enum", enum: ["none", "es5", "all"], group: { zh: "语法", en: "Syntax" } },
];

const DOCKER_COMPOSE_TOP: KnownDefinition[] = [
  { segments: ["name"], label: { zh: "项目名称", en: "Project Name" }, description: { zh: "Docker Compose 栈的名称，用于容器和网络前缀。", en: "Stack name used as prefix for containers, networks, and volumes." }, type: "string", group: { zh: "Compose 基本信息", en: "Compose General" } },
  { segments: ["version"], label: { zh: "Compose 语法版本", en: "Compose Version" }, description: { zh: "历史字段，新版 Compose V2 已可省略。", en: "Legacy schema version field (optional in Compose V2)." }, type: "string", group: { zh: "Compose 基本信息", en: "Compose General" } },
  { segments: ["networks"], label: { zh: "网络定义", en: "Networks" }, description: { zh: "跨服务通信使用的自定义 Docker 网络。", en: "Top-level custom Docker networks shared by services." }, type: "json", group: { zh: "网络与存储", en: "Networks & Storage" } },
  { segments: ["volumes"], label: { zh: "数据卷定义", en: "Volumes" }, description: { zh: "供服务挂载的命名持久化数据卷。", en: "Named persistent volumes shared across services." }, type: "json", group: { zh: "网络与存储", en: "Networks & Storage" } },
  { segments: ["configs"], label: { zh: "配置对象", en: "Configs" }, description: { zh: "挂载给服务使用的外部配置文件声明。", en: "External config declarations mounted into services." }, type: "json", group: { zh: "配置与密钥", en: "Configs & Secrets" } },
  { segments: ["secrets"], label: { zh: "密钥声明", en: "Secrets" }, description: { zh: "通过安全方式注入容器的敏感凭据声明。", en: "Sensitive secrets injected securely into services." }, type: "json", group: { zh: "配置与密钥", en: "Configs & Secrets" } },
];

const DOCKER_COMPOSE_SERVICE_FIELDS: Array<{
  key: string;
  label: BilingualText;
  description: BilingualText;
  type: FieldCandidate["type"];
  enum?: Array<string | number>;
}> = [
  { key: "image", label: { zh: "镜像", en: "Image" }, description: { zh: "容器启动所使用的 Docker 镜像及标签。", en: "Docker image and tag to launch for this service." }, type: "string" },
  { key: "container_name", label: { zh: "容器名称", en: "Container Name" }, description: { zh: "自定义容器名称（需保证主机内唯一）。", en: "Custom container name (must be unique on the host)." }, type: "string" },
  { key: "restart", label: { zh: "重启策略", en: "Restart Policy" }, description: { zh: "容器退出时的自动重启策略。", en: "Container restart policy upon exit." }, type: "enum", enum: ["no", "always", "on-failure", "unless-stopped"] },
  { key: "ports", label: { zh: "端口映射", en: "Ports" }, description: { zh: "宿主机与容器之间的端口映射列表（如 8080:80）。", en: "Published host-to-container port mappings (e.g. 8080:80)." }, type: "array" },
  { key: "volumes", label: { zh: "挂载卷", en: "Volumes" }, description: { zh: "宿主机路径或命名数据卷到容器目录的挂载配置。", en: "Host paths or named volumes mounted into the container." }, type: "array" },
  { key: "depends_on", label: { zh: "依赖服务", en: "Depends On" }, description: { zh: "当前服务启动前必须先就绪的其他服务。", en: "Other services that must start before this service." }, type: "array" },
  { key: "env_file", label: { zh: "环境变量文件", en: "Env File" }, description: { zh: "从指定 .env 文件加载环境变量注入容器。", en: "Environment file(s) loaded into the container." }, type: "array" },
  { key: "command", label: { zh: "启动命令", en: "Command" }, description: { zh: "覆盖镜像默认的启动命令。", en: "Overrides the default command declared in the image." }, type: "string" },
  { key: "working_dir", label: { zh: "工作目录", en: "Working Dir" }, description: { zh: "容器内进程启动时的默认工作目录。", en: "Default working directory inside the container." }, type: "string" },
  { key: "network_mode", label: { zh: "网络模式", en: "Network Mode" }, description: { zh: "容器网络模式（如 bridge、host、none）。", en: "Container network mode (e.g. bridge, host, none)." }, type: "enum", enum: ["bridge", "host", "none"] },
];

const PYPROJECT: KnownDefinition[] = [
  { segments: ["project", "name"], label: { zh: "项目名称", en: "Project Name" }, description: { zh: "Python 分发包名称（PEP 621）。", en: "Python distribution package name (PEP 621)." }, type: "string", required: true, group: { zh: "项目元数据", en: "Project Metadata" } },
  { segments: ["project", "version"], label: { zh: "版本号", en: "Version" }, description: { zh: "遵循 PEP 440 规范的项目版本号。", en: "Project version following PEP 440." }, type: "string", group: { zh: "项目元数据", en: "Project Metadata" } },
  { segments: ["project", "description"], label: { zh: "项目简介", en: "Description" }, description: { zh: "展示在 PyPI 等索引中的单行简介。", en: "Short one-line summary for package indexes such as PyPI." }, type: "string", group: { zh: "项目元数据", en: "Project Metadata" } },
  { segments: ["project", "readme"], label: { zh: "README 文件", en: "README File" }, description: { zh: "用作包长说明的 README 文件路径。", en: "Path to the README file used as long description." }, type: "string", group: { zh: "项目元数据", en: "Project Metadata" } },
  { segments: ["project", "requires-python"], label: { zh: "Python 版本要求", en: "Requires Python" }, description: { zh: "项目支持的 Python 解释器版本范围（如 >=3.10）。", en: "Supported Python version specifier (e.g. >=3.10)." }, type: "string", group: { zh: "项目元数据", en: "Project Metadata" } },
  { segments: ["project", "dependencies"], label: { zh: "运行依赖", en: "Dependencies" }, description: { zh: "项目运行所需的 Python 依赖列表（PEP 508）。", en: "Runtime Python package dependencies (PEP 508)." }, type: "array", group: { zh: "依赖与脚本", en: "Dependencies & Scripts" } },
  { segments: ["project", "scripts"], label: { zh: "CLI 入口脚本", en: "Console Scripts" }, description: { zh: "安装后注册到命令行的入口命令映射。", en: "Console script entry points installed with the package." }, type: "json", group: { zh: "依赖与脚本", en: "Dependencies & Scripts" } },
  { segments: ["build-system", "requires"], label: { zh: "构建依赖", en: "Build Requires" }, description: { zh: "构建此项目所需的 PEP 517 构建后端包列表。", en: "PEP 517 build-time package requirements." }, type: "array", group: { zh: "构建系统", en: "Build System" } },
  { segments: ["build-system", "build-backend"], label: { zh: "构建后端", en: "Build Backend" }, description: { zh: "用于打包的 Python 构建后端入口。", en: "Python object used as the PEP 517 build backend." }, type: "string", group: { zh: "构建系统", en: "Build System" } },
  { segments: ["tool", "ruff", "line-length"], label: { zh: "Ruff 行宽上限", en: "Ruff Line Length" }, description: { zh: "Ruff 代码检查与格式化的最大每行字符数。", en: "Maximum line length enforced by Ruff." }, type: "integer", minimum: 40, maximum: 240, group: { zh: "工具配置", en: "Tooling" } },
  { segments: ["tool", "ruff", "target-version"], label: { zh: "Ruff 目标 Python 版本", en: "Ruff Target Version" }, description: { zh: "Ruff 规则针对的最低 Python 版本（如 py311）。", en: "Minimum Python version targeted by Ruff (e.g. py311)." }, type: "enum", enum: ["py38", "py39", "py310", "py311", "py312", "py313"], group: { zh: "工具配置", en: "Tooling" } },
  { segments: ["tool", "mypy", "strict"], label: { zh: "Mypy 严格模式", en: "Mypy Strict Mode" }, description: { zh: "启用 Mypy 全部严格静态类型检查选项。", en: "Enable all strict static type checking options in Mypy." }, type: "boolean", group: { zh: "工具配置", en: "Tooling" } },
  { segments: ["tool", "pytest", "ini_options", "testpaths"], label: { zh: "Pytest 测试目录", en: "Pytest Test Paths" }, description: { zh: "Pytest 默认扫描测试用例的目录列表。", en: "Default directories searched by pytest." }, type: "array", group: { zh: "工具配置", en: "Tooling" } },
];

const CARGO: KnownDefinition[] = [
  { segments: ["package", "name"], label: { zh: "Crate 名称", en: "Crate Name" }, description: { zh: "Rust 包在 Cargo 与 crates.io 中的唯一标识。", en: "Unique Rust crate name in Cargo and crates.io." }, type: "string", required: true, group: { zh: "包信息", en: "Package" } },
  { segments: ["package", "version"], label: { zh: "版本号", en: "Version" }, description: { zh: "遵循 SemVer 的 Crate 版本号。", en: "SemVer version of the crate." }, type: "string", group: { zh: "包信息", en: "Package" } },
  { segments: ["package", "edition"], label: { zh: "Rust Edition", en: "Rust Edition" }, description: { zh: "编译器采用的 Rust 语言 Edition 版本。", en: "Rust language edition used to compile the crate." }, type: "enum", enum: ["2015", "2018", "2021", "2024"], group: { zh: "包信息", en: "Package" } },
  { segments: ["package", "description"], label: { zh: "简介", en: "Description" }, description: { zh: "展示在 crates.io 的简短项目说明。", en: "Short description displayed on crates.io." }, type: "string", group: { zh: "包信息", en: "Package" } },
  { segments: ["package", "license"], label: { zh: "开源许可证", en: "License" }, description: { zh: "SPDX 许可证表达式（如 MIT OR Apache-2.0）。", en: "SPDX license expression (e.g. MIT OR Apache-2.0)." }, type: "string", group: { zh: "包信息", en: "Package" } },
  { segments: ["package", "authors"], label: { zh: "作者列表", en: "Authors" }, description: { zh: "包维护者与作者信息列表。", en: "List of package authors and maintainers." }, type: "array", group: { zh: "包信息", en: "Package" } },
  { segments: ["package", "repository"], label: { zh: "源码仓库", en: "Repository" }, description: { zh: "项目源码仓库 URL。", en: "URL of the source code repository." }, type: "string", group: { zh: "包信息", en: "Package" } },
  { segments: ["package", "rust-version"], label: { zh: "最低 Rust 版本 (MSRV)", en: "Min Rust Version (MSRV)" }, description: { zh: "编译此 Crate 所需的最低 rustc 版本。", en: "Minimum supported rustc compiler version." }, type: "string", group: { zh: "包信息", en: "Package" } },
  { segments: ["package", "publish"], label: { zh: "允许发布", en: "Publish" }, description: { zh: "设为 false 可防止意外发布到 crates.io。", en: "Set to false to prevent publishing to crates.io." }, type: "boolean", group: { zh: "包信息", en: "Package" } },
  { segments: ["dependencies"], label: { zh: "运行依赖", en: "Dependencies" }, description: { zh: "Crate 编译与运行所需依赖。", en: "Normal runtime and build dependencies." }, type: "json", group: { zh: "依赖与特性", en: "Dependencies & Features" } },
  { segments: ["dev-dependencies"], label: { zh: "开发依赖", en: "Dev Dependencies" }, description: { zh: "仅用于测试、示例和基准测试的依赖。", en: "Dependencies only used for tests, examples, and benchmarks." }, type: "json", group: { zh: "依赖与特性", en: "Dependencies & Features" } },
  { segments: ["build-dependencies"], label: { zh: "构建脚本依赖", en: "Build Dependencies" }, description: { zh: "供 build.rs 构建脚本使用的依赖。", en: "Dependencies used by build.rs scripts." }, type: "json", group: { zh: "依赖与特性", en: "Dependencies & Features" } },
  { segments: ["features"], label: { zh: "条件编译特性", en: "Features" }, description: { zh: "可选功能开关与依赖组合。", en: "Optional Cargo feature flags and combinations." }, type: "json", group: { zh: "依赖与特性", en: "Dependencies & Features" } },
  { segments: ["workspace", "members"], label: { zh: "Workspace 成员", en: "Workspace Members" }, description: { zh: "Cargo 工作区包含的子 Crate 路径列表。", en: "Member crate paths included in this Cargo workspace." }, type: "array", group: { zh: "工作区与优化", en: "Workspace & Profiles" } },
  { segments: ["workspace", "resolver"], label: { zh: "依赖解析器版本", en: "Feature Resolver" }, description: { zh: "Cargo 特性解析算法版本（推荐 2 或 3）。", en: "Cargo feature resolver version (2 or 3 recommended)." }, type: "enum", enum: ["1", "2", "3"], group: { zh: "工作区与优化", en: "Workspace & Profiles" } },
  { segments: ["profile", "release", "lto"], label: { zh: "Release LTO 优化", en: "Release LTO" }, description: { zh: "启用链接时优化以减小体积或提升运行性能。", en: "Enable Link-Time Optimization for release builds." }, type: "boolean", group: { zh: "工作区与优化", en: "Workspace & Profiles" } },
  { segments: ["profile", "release", "strip"], label: { zh: "剥离调试符号", en: "Strip Symbols" }, description: { zh: "发布构建时移除调试符号以缩小二进制体积。", en: "Strip debug symbols from release binaries to reduce size." }, type: "boolean", group: { zh: "工作区与优化", en: "Workspace & Profiles" } },
  {
    segments: ["bin"],
    label: { zh: "可执行目标 ([[bin]])", en: "Binary Targets ([[bin]])" },
    description: { zh: "声明此 Crate 构建的可执行二进制目标列表。", en: "Executable binary targets built by this crate." },
    type: "array",
    group: { zh: "构建目标", en: "Targets" },
    itemFields: [
      { key: "name", label: { zh: "目标名称", en: "Name" }, description: { zh: "生成的二进制可执行文件名。", en: "Name of the generated binary." }, type: "string", required: true },
      { key: "path", label: { zh: "入口文件", en: "Path" }, description: { zh: "二进制入口源码路径（如 src/main.rs）。", en: "Source entry file path (e.g. src/main.rs)." }, type: "string" },
      { key: "required-features", label: { zh: "依赖特性", en: "Required Features" }, description: { zh: "构建此目标前必须启用的 Cargo features。", en: "Cargo features required to build this binary." }, type: "array" },
    ],
  },
];

const EDITORCONFIG: KnownDefinition[] = [
  { segments: ["root"], label: { zh: "根目录标记", en: "Root" }, description: { zh: "设为 true 以停止向上级目录继续查找 .editorconfig。", en: "Stop searching parent directories for additional .editorconfig files." }, type: "boolean", group: { zh: "全局", en: "Global" } },
  { segments: ["*", "indent_style"], label: { zh: "缩进方式", en: "Indent Style" }, description: { zh: "默认使用空格（space）或制表符（tab）缩进。", en: "Default indentation style (space or tab)." }, type: "enum", enum: ["space", "tab"], group: { zh: "默认规则 (*)", en: "Default Rules (*)" } },
  { segments: ["*", "indent_size"], label: { zh: "缩进宽度", en: "Indent Size" }, description: { zh: "每级缩进占用的列数。", en: "Number of columns used for each indentation level." }, type: "integer", minimum: 1, maximum: 16, group: { zh: "默认规则 (*)", en: "Default Rules (*)" } },
  { segments: ["*", "end_of_line"], label: { zh: "换行符", en: "End of Line" }, description: { zh: "控制文件保存使用的行尾序列（lf / crlf / cr）。", en: "Line ending convention (lf, crlf, or cr)." }, type: "enum", enum: ["lf", "crlf", "cr"], group: { zh: "默认规则 (*)", en: "Default Rules (*)" } },
  { segments: ["*", "charset"], label: { zh: "字符编码", en: "Charset" }, description: { zh: "文件默认字符编码（推荐 utf-8）。", en: "Default file character encoding (utf-8 recommended)." }, type: "enum", enum: ["utf-8", "utf-8-bom", "latin1", "utf-16be", "utf-16le"], group: { zh: "默认规则 (*)", en: "Default Rules (*)" } },
  { segments: ["*", "trim_trailing_whitespace"], label: { zh: "移除行尾空白", en: "Trim Trailing Whitespace" }, description: { zh: "保存时自动删除每行末尾多余的空白字符。", en: "Remove trailing whitespace characters on save." }, type: "boolean", group: { zh: "默认规则 (*)", en: "Default Rules (*)" } },
  { segments: ["*", "insert_final_newline"], label: { zh: "末尾插入空行", en: "Insert Final Newline" }, description: { zh: "确保文件以一个换行符结尾。", en: "Ensure files end with a trailing newline." }, type: "boolean", group: { zh: "默认规则 (*)", en: "Default Rules (*)" } },
];

const NPMRC: KnownDefinition[] = [
  { segments: ["registry"], label: { zh: "默认 Registry", en: "Default Registry" }, description: { zh: "npm / pnpm 安装与发布包使用的默认镜像源 URL。", en: "Base URL of the npm package registry." }, type: "string", group: { zh: "镜像源", en: "Registry" } },
  { segments: ["save-exact"], label: { zh: "锁定精确版本", en: "Save Exact" }, description: { zh: "安装包时写入精确版本号，不添加 ^ 范围前缀。", en: "Save exact package versions rather than semver ranges." }, type: "boolean", group: { zh: "依赖策略", en: "Dependencies" } },
  { segments: ["engine-strict"], label: { zh: "严格检查引擎版本", en: "Engine Strict" }, description: { zh: "Node/npm 版本不满足 package.json engines 要求时中止安装。", en: "Fail installs when Node/npm versions do not satisfy engines." }, type: "boolean", group: { zh: "依赖策略", en: "Dependencies" } },
  { segments: ["legacy-peer-deps"], label: { zh: "宽松 Peer 依赖", en: "Legacy Peer Deps" }, description: { zh: "忽略冲突的 peerDependencies 检查（兼容 npm v6 行为）。", en: "Ignore peerDependency conflicts (npm v6 compatibility)." }, type: "boolean", group: { zh: "依赖策略", en: "Dependencies" } },
  { segments: ["strict-ssl"], label: { zh: "严格 TLS 校验", en: "Strict SSL" }, description: { zh: "访问 HTTPS 镜像源时严格校验证书有效性。", en: "Enforce TLS certificate validation for HTTPS registry requests." }, type: "boolean", group: { zh: "网络与安全", en: "Network & Security" } },
  { segments: ["audit"], label: { zh: "安装时安全审计", en: "Security Audit" }, description: { zh: "执行安装命令时自动上报并检查已知安全漏洞。", en: "Submit audit reports during install commands." }, type: "boolean", group: { zh: "网络与安全", en: "Network & Security" } },
  { segments: ["fund"], label: { zh: "显示赞助提示", en: "Funding Messages" }, description: { zh: "在安装完成后显示依赖包的开源赞助信息。", en: "Display funding messages after installs." }, type: "boolean", group: { zh: "界面输出", en: "Output" } },
];

const LAUNCH_JSON: KnownDefinition[] = [
  { segments: ["version"], label: { zh: "配置版本", en: "Schema Version" }, description: { zh: "VS Code launch.json 格式版本号（通常为 0.2.0）。", en: "VS Code launch.json schema version (typically 0.2.0)." }, type: "string", group: { zh: "常规", en: "General" } },
  {
    segments: ["configurations"],
    label: { zh: "调试配置列表", en: "Debug Configurations" },
    description: { zh: "可在 VS Code 调试面板中启动或附加的运行配置列表。", en: "List of launch or attach debug configurations shown in VS Code." },
    type: "array",
    group: { zh: "调试配置", en: "Configurations" },
    itemFields: [
      { key: "name", label: { zh: "配置名称", en: "Name" }, description: { zh: "展示在调试下拉菜单中的可读名称。", en: "Friendly name displayed in the VS Code launch configuration dropdown." }, type: "string", required: true },
      { key: "type", label: { zh: "调试器类型", en: "Debugger Type" }, description: { zh: "调试器适配器类型（如 node、pwa-node、python、chrome、go、lldb）。", en: "Debugger adapter type (e.g. node, pwa-node, python, chrome, go, lldb)." }, type: "string", required: true },
      { key: "request", label: { zh: "调试模式", en: "Request Type" }, description: { zh: "启动新进程（launch）或附加到已运行进程（attach）。", en: "Launch a new debugged process or attach to an already running one." }, type: "enum", enum: ["launch", "attach"], required: true },
      { key: "program", label: { zh: "入口程序", en: "Program" }, description: { zh: "要调试的入口脚本或可执行文件路径。", en: "Path to the entry script or executable to debug." }, type: "string" },
      { key: "cwd", label: { zh: "工作目录", en: "Working Directory" }, description: { zh: "调试目标启动时使用的当前工作目录。", en: "Current working directory for the debugged process." }, type: "string" },
      { key: "args", label: { zh: "命令行参数", en: "Arguments" }, description: { zh: "传递给被调试程序的命令行参数数组。", en: "Command-line arguments passed to the program." }, type: "array" },
      { key: "env", label: { zh: "环境变量", en: "Environment Variables" }, description: { zh: "注入调试进程环境的键值对。", en: "Environment variables injected into the debugged process." }, type: "json" },
      { key: "envFile", label: { zh: "环境变量文件", en: "Env File" }, description: { zh: "启动调试前自动加载的 .env 文件路径。", en: "Path to a .env file loaded before launching the debugger." }, type: "string" },
      { key: "port", label: { zh: "调试端口", en: "Debug Port" }, description: { zh: "调试协议监听或附加使用的 TCP 端口号。", en: "TCP port used to attach or communicate with the debugger." }, type: "integer", minimum: 1, maximum: 65535 },
      { key: "console", label: { zh: "控制台类型", en: "Console" }, description: { zh: "指定调试输出的承载终端。", en: "Console used for launching the debug target." }, type: "enum", enum: ["internalConsole", "integratedTerminal", "externalTerminal"] },
      { key: "runtimeExecutable", label: { zh: "运行时可执行文件", en: "Runtime Executable" }, description: { zh: "自定义运行时路径（如 npm、pnpm、tsx 或 python 路径）。", en: "Custom runtime binary to execute (e.g. npm, pnpm, tsx, or python)." }, type: "string" },
      { key: "preLaunchTask", label: { zh: "启动前任务", en: "Pre-Launch Task" }, description: { zh: "开始调试前在 tasks.json 中自动执行的任务名。", en: "Task from tasks.json to run before starting the debug session." }, type: "string" },
      { key: "postDebugTask", label: { zh: "调试后任务", en: "Post-Debug Task" }, description: { zh: "调试会话结束后自动执行的清理任务名。", en: "Task from tasks.json to run after the debug session ends." }, type: "string" },
      { key: "sourceMaps", label: { zh: "启用 Source Map", en: "Source Maps" }, description: { zh: "使用 Source Map 将编译后代码映射回原始源码断点。", en: "Use source maps to map compiled output back to original source files." }, type: "boolean" },
      { key: "stopOnEntry", label: { zh: "入口处暂停", en: "Stop on Entry" }, description: { zh: "程序启动后立即在第一行断点暂停。", en: "Automatically pause execution at program entry." }, type: "boolean" },
      { key: "skipFiles", label: { zh: "跳过文件", en: "Skip Files" }, description: { zh: "单步调试时自动忽略的文件 glob 列表（如 <node_internals>/**）。", en: "Glob patterns of files to skip while stepping through code." }, type: "array" },
    ],
  },
  {
    segments: ["compounds"],
    label: { zh: "复合启动配置", en: "Compound Configurations" },
    description: { zh: "同时启动多个关联调试配置的组合定义。", en: "Composite definitions that launch multiple debug configurations together." },
    type: "array",
    group: { zh: "复合配置", en: "Compounds" },
    itemFields: [
      { key: "name", label: { zh: "复合名称", en: "Name" }, description: { zh: "复合启动项在调试列表中的名称。", en: "Display name of the compound configuration." }, type: "string", required: true },
      { key: "configurations", label: { zh: "包含的配置名", en: "Configurations" }, description: { zh: "要同时启动的子配置名称列表。", en: "Names of individual configurations to start together." }, type: "array", required: true },
      { key: "preLaunchTask", label: { zh: "启动前任务", en: "Pre-Launch Task" }, description: { zh: "启动全部子配置前执行的准备任务。", en: "Task executed before starting all member configurations." }, type: "string" },
      { key: "stopAll", label: { zh: "联动停止", en: "Stop All" }, description: { zh: "任意一个子会话终止时自动停止其余所有会话。", en: "Stop all compound sessions when any single session terminates." }, type: "boolean" },
    ],
  },
  {
    segments: ["inputs"],
    label: { zh: "交互式输入变量", en: "Input Variables" },
    description: { zh: "供 ${input:id} 引用的交互式参数提示定义。", en: "Interactive prompt definitions referenced via ${input:id}." },
    type: "array",
    group: { zh: "变量与输入", en: "Inputs" },
    itemFields: [
      { key: "id", label: { zh: "变量 ID", en: "Input ID" }, description: { zh: "在配置中通过 ${input:<id>} 引用的唯一标识。", en: "Unique identifier referenced as ${input:<id>}." }, type: "string", required: true },
      { key: "type", label: { zh: "输入类型", en: "Input Type" }, description: { zh: "文本输入（promptString）、下拉选择（pickString）或命令输出（command）。", en: "Prompt input style: free text, option picker, or command output." }, type: "enum", enum: ["promptString", "pickString", "command"], required: true },
      { key: "description", label: { zh: "提示说明", en: "Description" }, description: { zh: "向用户展示的输入提示文案。", en: "Prompt message shown to the user." }, type: "string" },
      { key: "default", label: { zh: "默认值", en: "Default Value" }, description: { zh: "用户直接回车确认时使用的默认值。", en: "Fallback value used if the user submits without typing." }, type: "string" },
      { key: "password", label: { zh: "密码模式", en: "Password Input" }, description: { zh: "启用后在输入框中以掩码隐藏用户输入内容。", en: "Masks user input in the prompt box for sensitive values." }, type: "boolean" },
    ],
  },
];

const VERCEL_JSON: KnownDefinition[] = [
  { segments: ["framework"], label: { zh: "前端框架", en: "Framework" }, description: { zh: "Vercel 用于自动配置构建与路由预设的框架标识（如 nextjs、vite、astro）。", en: "Framework preset used by Vercel for build and routing defaults (e.g. nextjs, vite, astro)." }, type: "string", group: { zh: "构建与部署", en: "Build & Deployment" } },
  { segments: ["buildCommand"], label: { zh: "构建命令", en: "Build Command" }, description: { zh: "覆盖框架默认构建流程的自定义 Shell 命令。", en: "Custom shell command overriding the default framework build step." }, type: "string", group: { zh: "构建与部署", en: "Build & Deployment" } },
  { segments: ["devCommand"], label: { zh: "本地开发命令", en: "Dev Command" }, description: { zh: "vercel dev 启动本地开发服务器时执行的命令。", en: "Command executed by vercel dev to start the local development server." }, type: "string", group: { zh: "构建与部署", en: "Build & Deployment" } },
  { segments: ["installCommand"], label: { zh: "依赖安装命令", en: "Install Command" }, description: { zh: "覆盖默认包管理器安装阶段的自定义命令。", en: "Custom command overriding the default dependency installation step." }, type: "string", group: { zh: "构建与部署", en: "Build & Deployment" } },
  { segments: ["outputDirectory"], label: { zh: "构建输出目录", en: "Output Directory" }, description: { zh: "存放编译后静态资源与产物的相对目录（如 dist、build）。", en: "Relative directory containing compiled static build artifacts (e.g. dist, build)." }, type: "string", group: { zh: "构建与部署", en: "Build & Deployment" } },
  { segments: ["ignoreCommand"], label: { zh: "忽略构建检查命令", en: "Ignore Build Step" }, description: { zh: "返回退出码 0 时跳过本次部署构建的自定义脚本。", en: "Shell command that skips the build when it exits with code 0." }, type: "string", group: { zh: "构建与部署", en: "Build & Deployment" } },
  { segments: ["public"], label: { zh: "公开源码与日志", en: "Public Source & Logs" }, description: { zh: "允许公开访问部署源码与构建日志（默认关闭）。", en: "Makes deployment source code and build logs publicly accessible." }, type: "boolean", group: { zh: "基本信息", en: "General" } },
  { segments: ["cleanUrls"], label: { zh: "简洁 URL", en: "Clean URLs" }, description: { zh: "自动隐藏静态页面路径末尾的 .html 扩展名。", en: "Automatically drops the .html extension from static page URLs." }, type: "boolean", group: { zh: "路由与重写", en: "Routing" } },
  { segments: ["trailingSlash"], label: { zh: "保留尾部斜杠", en: "Trailing Slash" }, description: { zh: "控制路由是否统一规范化为带尾部斜杠（/）的 URL。", en: "Controls whether URLs are normalized with or without a trailing slash." }, type: "boolean", group: { zh: "路由与重写", en: "Routing" } },
  {
    segments: ["rewrites"],
    label: { zh: "URL 重写规则", en: "Rewrites" },
    description: { zh: "在不改变浏览器地址栏的前提下将请求代理或映射到目标路径。", en: "Maps incoming request paths to destination paths or URLs without changing the browser URL." },
    type: "array",
    group: { zh: "路由与重写", en: "Routing" },
    itemFields: [
      { key: "source", label: { zh: "匹配路径", en: "Source Pattern" }, description: { zh: "需要匹配的入站请求路径模式（如 /api/:path*）。", en: "Incoming path pattern to match (e.g. /api/:path*)." }, type: "string", required: true },
      { key: "destination", label: { zh: "目标地址", en: "Destination" }, description: { zh: "重写后的内部路径或外部代理目标 URL。", en: "Target internal path or external URL to proxy to." }, type: "string", required: true },
    ],
  },
  {
    segments: ["redirects"],
    label: { zh: "URL 重定向规则", en: "Redirects" },
    description: { zh: "将匹配的请求通过 HTTP 3xx 跳转到新的目标路径。", en: "Redirects matching incoming paths via HTTP 3xx responses." },
    type: "array",
    group: { zh: "路由与重写", en: "Routing" },
    itemFields: [
      { key: "source", label: { zh: "匹配路径", en: "Source Pattern" }, description: { zh: "触发重定向的原始路径模式。", en: "Incoming path pattern that triggers the redirect." }, type: "string", required: true },
      { key: "destination", label: { zh: "目标地址", en: "Destination" }, description: { zh: "重定向跳转的新路径或完整 URL。", en: "Target path or full URL to redirect to." }, type: "string", required: true },
      { key: "permanent", label: { zh: "永久重定向", en: "Permanent" }, description: { zh: "设为 true 返回 308 永久跳转，false 返回 307 临时跳转。", en: "Use HTTP 308 permanent redirect when true, or 307 temporary redirect when false." }, type: "boolean" },
      { key: "statusCode", label: { zh: "HTTP 状态码", en: "Status Code" }, description: { zh: "显式指定重定向状态码（301–308）。", en: "Explicit HTTP redirect status code (301–308)." }, type: "integer", minimum: 301, maximum: 308 },
    ],
  },
  {
    segments: ["headers"],
    label: { zh: "自定义响应头", en: "Custom Headers" },
    description: { zh: "按路径规则附加自定义 HTTP 响应头（如 CORS、CSP 与缓存策略）。", en: "Attaches custom HTTP response headers (e.g. CORS, CSP, caching) by path pattern." },
    type: "array",
    group: { zh: "路由与重写", en: "Routing" },
    itemFields: [
      { key: "source", label: { zh: "匹配路径", en: "Source Pattern" }, description: { zh: "应用响应头的路径模式（如 /(.*)）。", en: "Path pattern where these headers apply (e.g. /(.*))." }, type: "string", required: true },
      { key: "headers", label: { zh: "响应头列表", en: "Headers" }, description: { zh: "由 key 与 value 组成的响应头条目列表。", en: "List of { key, value } HTTP response header objects." }, type: "array", required: true },
    ],
  },
  { segments: ["regions"], label: { zh: "部署区域", en: "Regions" }, description: { zh: "无服务器函数部署的目标 Vercel 区域代码列表（如 iad1、hnd1、sin1）。", en: "Target Vercel deployment region codes for serverless functions (e.g. iad1, hnd1, sin1)." }, type: "array", group: { zh: "运行时与函数", en: "Runtime & Functions" } },
  { segments: ["functions"], label: { zh: "无服务器函数配置", en: "Functions" }, description: { zh: "按函数文件路径配置内存、超时时间（maxDuration）与运行时。", en: "Per-function memory, maxDuration, and runtime overrides keyed by file pattern." }, type: "json", group: { zh: "运行时与函数", en: "Runtime & Functions" } },
  {
    segments: ["crons"],
    label: { zh: "定时任务 (Cron Jobs)", en: "Cron Jobs" },
    description: { zh: "按 Cron 表达式定时触发项目 API 路由的计划任务列表。", en: "Scheduled Vercel Cron Jobs invoking project endpoints on a cron schedule." },
    type: "array",
    group: { zh: "运行时与函数", en: "Runtime & Functions" },
    itemFields: [
      { key: "path", label: { zh: "触发接口路径", en: "Endpoint Path" }, description: { zh: "定时调用的站内相对 API 路径（必须以 / 开头）。", en: "Relative API route path invoked on schedule (must start with /)." }, type: "string", required: true },
      { key: "schedule", label: { zh: "Cron 表达式", en: "Schedule" }, description: { zh: "标准 5 段 UTC Cron 表达式（如 0 5 * * *）。", en: "Standard 5-field UTC cron expression (e.g. 0 5 * * *)." }, type: "string", required: true },
    ],
  },
  { segments: ["env"], label: { zh: "环境变量", en: "Environment Variables" }, description: { zh: "运行时注入部署环境的键值映射。", en: "Runtime environment variable key-value mappings for deployments." }, type: "json", group: { zh: "环境变量", en: "Environment" } },
  { segments: ["git"], label: { zh: "Git 部署设置", en: "Git Settings" }, description: { zh: "控制不同 Git 分支是否自动触发部署（deploymentEnabled）。", en: "Controls per-branch automatic deployment behavior (e.g. deploymentEnabled)." }, type: "json", group: { zh: "Git 集成", en: "Git Integration" } },
  { segments: ["github"], label: { zh: "GitHub 集成", en: "GitHub Integration" }, description: { zh: "控制 GitHub PR 评论、提交状态与自动部署行为。", en: "Configures GitHub PR comments, commit checks, and automatic deployments." }, type: "json", group: { zh: "Git 集成", en: "Git Integration" } },
];

const ENV_COMMON: KnownDefinition[] = [
  { segments: ["PORT"], label: { zh: "监听端口", en: "Server Port" }, description: { zh: "服务监听的 TCP 端口号（1–65535）。", en: "TCP port number the service listens on (1–65535)." }, type: "integer", minimum: 1, maximum: 65535, group: { zh: "服务与网络", en: "Server & Network" } },
  { segments: ["HOST"], label: { zh: "监听主机", en: "Bind Host" }, description: { zh: "服务绑定的网络地址（本地开发常用 127.0.0.1，容器常用 0.0.0.0）。", en: "Network interface address to bind (e.g. 127.0.0.1 or 0.0.0.0)." }, type: "string", group: { zh: "服务与网络", en: "Server & Network" } },
  { segments: ["NODE_ENV"], label: { zh: "Node 运行环境", en: "Node Environment" }, description: { zh: "控制框架缓存、错误堆栈与优化开关。", en: "Controls framework caching, error verbosity, and optimizations." }, type: "enum", enum: ["development", "test", "staging", "production"], group: { zh: "运行环境", en: "Runtime" } },
  { segments: ["APP_ENV"], label: { zh: "应用运行环境", en: "App Environment" }, description: { zh: "标识当前部署环境（开发/测试/预发/生产）。", en: "Identifies the active deployment environment." }, type: "enum", enum: ["development", "test", "staging", "production"], group: { zh: "运行环境", en: "Runtime" } },
  { segments: ["APP_NAME"], label: { zh: "应用名称", en: "App Name" }, description: { zh: "在日志、邮件或界面标题中展示的应用名称。", en: "Application name displayed in logs, emails, or UI headers." }, type: "string", group: { zh: "运行环境", en: "Runtime" } },
  { segments: ["APP_URL"], label: { zh: "应用访问地址", en: "App URL" }, description: { zh: "应用对外可访问的完整根 URL（用于回调与链接生成）。", en: "Public base URL used for callbacks and generated links." }, type: "string", group: { zh: "服务与网络", en: "Server & Network" } },
  { segments: ["BASE_URL"], label: { zh: "基础 URL", en: "Base URL" }, description: { zh: "API 或前端请求使用的基础路径 URL。", en: "Base URL prefix for API or web requests." }, type: "string", group: { zh: "服务与网络", en: "Server & Network" } },
  { segments: ["CORS_ORIGIN"], label: { zh: "CORS 允许来源", en: "CORS Origin" }, description: { zh: "允许跨域访问的前端域名或通配规则。", en: "Allowed frontend origin(s) for Cross-Origin Resource Sharing." }, type: "string", group: { zh: "服务与网络", en: "Server & Network" } },
  { segments: ["LOG_LEVEL"], label: { zh: "日志级别", en: "Log Level" }, description: { zh: "控制输出日志的最低严重等级。", en: "Minimum severity level for emitted log entries." }, type: "enum", enum: ["trace", "debug", "info", "warn", "error", "fatal", "silent"], group: { zh: "日志与调试", en: "Logging & Debug" } },
  { segments: ["DEBUG"], label: { zh: "调试模式", en: "Debug Mode" }, description: { zh: "启用更详细的调试日志或开发诊断功能。", en: "Enables verbose diagnostic output and debugging helpers." }, type: "boolean", group: { zh: "日志与调试", en: "Logging & Debug" } },
  { segments: ["TZ"], label: { zh: "时区", en: "Timezone" }, description: { zh: "进程默认使用的 IANA 时区（如 UTC、Asia/Shanghai）。", en: "Default IANA timezone for the process (e.g. UTC, Asia/Shanghai)." }, type: "string", group: { zh: "运行环境", en: "Runtime" } },
  { segments: ["DATABASE_URL"], label: { zh: "数据库连接串", en: "Database URL" }, description: { zh: "包含协议、凭据与库名的完整数据库 DSN。", en: "Full database connection URI / DSN including credentials." }, type: "secret", secret: true, group: { zh: "数据库与缓存", en: "Database & Cache" } },
  { segments: ["REDIS_URL"], label: { zh: "Redis 连接串", en: "Redis URL" }, description: { zh: "Redis 缓存或队列服务的连接地址。", en: "Connection URI for the Redis cache or queue server." }, type: "secret", secret: true, group: { zh: "数据库与缓存", en: "Database & Cache" } },
  { segments: ["JWT_SECRET"], label: { zh: "JWT 签名密钥", en: "JWT Secret" }, description: { zh: "用于签发与验证 JWT 令牌的私有密钥。", en: "Secret key used to sign and verify JWT tokens." }, type: "secret", secret: true, group: { zh: "安全与凭据", en: "Security & Credentials" } },
  { segments: ["SESSION_SECRET"], label: { zh: "会话加密密钥", en: "Session Secret" }, description: { zh: "用于签名与加密用户 Session Cookie 的密钥。", en: "Secret used to sign and encrypt session cookies." }, type: "secret", secret: true, group: { zh: "安全与凭据", en: "Security & Credentials" } },
  { segments: ["API_KEY"], label: { zh: "API 密钥", en: "API Key" }, description: { zh: "访问外部或内部受保护接口的认证密钥。", en: "Authentication key for protected API endpoints." }, type: "secret", secret: true, group: { zh: "安全与凭据", en: "Security & Credentials" } },
  { segments: ["OPENAI_API_KEY"], label: { zh: "OpenAI API Key", en: "OpenAI API Key" }, description: { zh: "调用 OpenAI 或兼容模型服务所需的 API 密钥。", en: "API key for OpenAI or OpenAI-compatible inference APIs." }, type: "secret", secret: true, group: { zh: "安全与凭据", en: "Security & Credentials" } },
  { segments: ["SENTRY_DSN"], label: { zh: "Sentry DSN", en: "Sentry DSN" }, description: { zh: "错误监控上报使用的 Sentry 数据源名称。", en: "Sentry Data Source Name for error telemetry reporting." }, type: "secret", secret: true, group: { zh: "日志与调试", en: "Logging & Debug" } },
  { segments: ["SMTP_HOST"], label: { zh: "SMTP 服务器", en: "SMTP Host" }, description: { zh: "发送邮件使用的 SMTP 主机地址。", en: "Hostname of the outgoing SMTP mail server." }, type: "string", group: { zh: "邮件与存储", en: "Mail & Storage" } },
  { segments: ["SMTP_PORT"], label: { zh: "SMTP 端口", en: "SMTP Port" }, description: { zh: "SMTP 服务端口（常见 25、465、587）。", en: "Port number for SMTP (commonly 25, 465, or 587)." }, type: "integer", minimum: 1, maximum: 65535, group: { zh: "邮件与存储", en: "Mail & Storage" } },
  { segments: ["SMTP_USER"], label: { zh: "SMTP 用户名", en: "SMTP User" }, description: { zh: "SMTP 认证账号。", en: "Username for SMTP authentication." }, type: "string", group: { zh: "邮件与存储", en: "Mail & Storage" } },
  { segments: ["SMTP_PASS"], label: { zh: "SMTP 密码", en: "SMTP Password" }, description: { zh: "SMTP 认证密码或授权码。", en: "Password or app-specific token for SMTP authentication." }, type: "secret", secret: true, group: { zh: "邮件与存储", en: "Mail & Storage" } },
  { segments: ["S3_BUCKET"], label: { zh: "S3 存储桶", en: "S3 Bucket" }, description: { zh: "对象存储桶名称。", en: "Object storage bucket name." }, type: "string", group: { zh: "邮件与存储", en: "Mail & Storage" } },
  { segments: ["S3_REGION"], label: { zh: "S3 区域", en: "S3 Region" }, description: { zh: "对象存储服务所在地域代码（如 us-east-1）。", en: "Cloud region code for the object storage bucket (e.g. us-east-1)." }, type: "string", group: { zh: "邮件与存储", en: "Mail & Storage" } },
  { segments: ["S3_ENDPOINT"], label: { zh: "S3 端点地址", en: "S3 Endpoint" }, description: { zh: "兼容 S3 协议的自定义对象存储端点 URL。", en: "Custom endpoint URL for S3-compatible object storage." }, type: "string", group: { zh: "邮件与存储", en: "Mail & Storage" } },
  { segments: ["AWS_ACCESS_KEY_ID"], label: { zh: "AWS Access Key ID", en: "AWS Access Key ID" }, description: { zh: "AWS / S3 兼容服务的访问密钥 ID。", en: "Access key identifier for AWS or S3-compatible services." }, type: "secret", secret: true, group: { zh: "安全与凭据", en: "Security & Credentials" } },
  { segments: ["AWS_SECRET_ACCESS_KEY"], label: { zh: "AWS Secret Access Key", en: "AWS Secret Access Key" }, description: { zh: "AWS / S3 兼容服务的私有访问密钥。", en: "Secret access key for AWS or S3-compatible services." }, type: "secret", secret: true, group: { zh: "安全与凭据", en: "Security & Credentials" } },
];

export function inferKnownFields(
  kind: string,
  value: unknown,
  format?: ConfigFormat,
  locale: Locale = "zh-CN",
): FieldCandidate[] {
  const lower = kind.toLowerCase();
  const isCompose = lower === "docker-compose.yml"
    || lower === "docker-compose.yaml"
    || lower === "compose.yml"
    || lower === "compose.yaml";
  const isEnv = format === "env" || lower === ".env" || lower.startsWith(".env.") || lower.endsWith(".env");

  let definitions: KnownDefinition[] = [];
  if (lower === "package.json") definitions = PACKAGE;
  else if (lower === "tsconfig.json" || lower === "jsconfig.json") definitions = TSCONFIG;
  else if (lower.includes("eslint")) definitions = ESLINT;
  else if (lower.includes("prettier")) definitions = PRETTIER;
  else if (isCompose) definitions = [...DOCKER_COMPOSE_TOP, ...expandDockerComposeServices(value)];
  else if (lower === "pyproject.toml") definitions = PYPROJECT;
  else if (lower === "cargo.toml") definitions = CARGO;
  else if (lower === "launch.json") definitions = LAUNCH_JSON;
  else if (lower === "vercel.json") definitions = VERCEL_JSON;
  else if (lower === ".editorconfig") definitions = EDITORCONFIG;
  else if (lower === ".npmrc") definitions = NPMRC;
  else if (isEnv) definitions = ENV_COMMON;

  const isEn = locale === "en-US";
  const detail = isEn
    ? `Built-in Confui template for ${kind}`
    : `Confui 内置的 ${kind} 字段知识`;

  return definitions
    .filter((definition) => definition.required || getAtPath(value, definition.segments) !== undefined)
    .map((definition, order) => ({
      segments: definition.segments,
      label: isEn ? definition.label.en : definition.label.zh,
      description: isEn ? definition.description.en : definition.description.zh,
      type: definition.type,
      enum: definition.enum,
      minimum: definition.minimum,
      maximum: definition.maximum,
      required: definition.required,
      secret: definition.secret,
      placeholder: definition.placeholder,
      group: definition.group ? (isEn ? definition.group.en : definition.group.zh) : undefined,
      itemFields: definition.itemFields?.map((item): ItemFieldSpec => ({
        key: item.key,
        label: isEn ? item.label.en : item.label.zh,
        description: isEn ? item.description.en : item.description.zh,
        type: item.type ?? "string",
        required: item.required,
        enum: item.enum,
        minimum: item.minimum,
        maximum: item.maximum,
      })),
      value: getAtPath(value, definition.segments),
      source: "known-template" as const,
      confidence: 0.97,
      detail,
      order,
    }));
}

function expandDockerComposeServices(value: unknown): KnownDefinition[] {
  const services = getAtPath(value, ["services"]);
  if (services === null || typeof services !== "object" || Array.isArray(services)) return [];
  const defs: KnownDefinition[] = [];
  for (const [serviceName, serviceConfig] of Object.entries(services as Record<string, unknown>)) {
    if (serviceConfig === null || typeof serviceConfig !== "object" || Array.isArray(serviceConfig)) continue;
    for (const template of DOCKER_COMPOSE_SERVICE_FIELDS) {
      if (getAtPath(serviceConfig, [template.key]) === undefined) continue;
      defs.push({
        segments: ["services", serviceName, template.key],
        label: {
          zh: `${serviceName} · ${template.label.zh}`,
          en: `${serviceName} · ${template.label.en}`,
        },
        description: template.description,
        type: template.type,
        enum: template.enum,
        group: { zh: `服务 · ${serviceName}`, en: `Service · ${serviceName}` },
      });
    }
  }
  return defs;
}
