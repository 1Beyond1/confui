import type { ConfigFormat, Locale, PathSegment } from "../../shared/schema.ts";
import { getAtPath } from "../paths.ts";
import type { FieldCandidate } from "./types.ts";

interface BilingualText {
  zh: string;
  en: string;
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
