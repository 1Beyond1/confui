# Confui 0.4 产品与验收规格

## 1. 产品目标

Confui 面向经常下载、试用开源项目但不想反复阅读配置文档的用户。用户选择本地项目后，应用应完成四件事：

1. 找到真正可编辑的配置文件。
2. 尽可能解释字段的用途、类型、约束、默认值和敏感性。
3. 用合适的桌面控件编辑（含可视化数组/键值表、撤销重做、新增/删除键），并在输入阶段阻止明显错误。
4. 在不静默覆盖外部修改、不破坏注释排版、不泄露凭据的前提下安全写回文件，并支持 `.bak` 一键回滚。

Confui 不是代码配置执行器，不解析或改写 `vite.config.ts`、`next.config.js` 等可执行源码；也不是远程仓库编辑器。

## 2. 当前范围

### 输入

- 本地项目文件夹：必选，是扫描和编辑的数据源。
- GitHub 仓库链接：可选，仅在本地 README 缺失时作为文档回退；非法链接在首页给出明确行内校验提示。
- 本地 `.git/config` 中的 GitHub remote：可自动识别。

### 配置格式

- JSON / JSONC（AST 增量写回，支持注释与尾随逗号，拒绝重复键）
- YAML / YML（`yaml` v2 CST 增量保真，保留注释/缩进/键顺序/特殊标量，拒绝循环引用）
- TOML（`smol-toml` 校验 + 源码原地补丁保真，保留注释/空行/表头顺序，复杂结构按需回退并提示）
- ENV（逐行保真，支持 `export`、引号与行尾注释）
- INI / CFG / CONF（逐行保真，支持 `=` / `:`、`key[]` 数组，拒开非 INI 指令式 `.conf`/`.cfg`）
- Java Properties（逻辑行保真，支持转义键与反斜杠续行）

### 不扫描

- 锁文件、Schema、示例文件、备份文件（`*.bak`）
- `node_modules`、`.git`、构建产物、缓存、虚拟环境
- JavaScript / TypeScript 配置源码
- 超过 5 MB 的文件只显示警告，不打开

## 3. 架构

```text
Preact renderer (web/src: App / components / hooks / i18n / utils)
      |
contextBridge typed IPC (electron/preload.ts -> window.confui)
      |
Electron main process (electron/main.ts)
      |
core modules (formats/ | inference/ | ai/ | scanner | save | settings | paths | files)
      |
shared contracts & pure utilities (schema.ts | validation.ts | diff.ts)
```

- 无 Fastify、无本地端口、无 HTTP 后端。
- Renderer 开启 `contextIsolation` 和 `sandbox`，关闭 `nodeIntegration`，生产环境强制 CSP。
- Preload 以 sandbox 兼容的 CommonJS 产物加载。
- 所有 IPC 返回统一的 `Result<T>`，错误包含稳定 code 与用户可读说明。
- 十六进制颜色正则、原型污染危险键黑名单与 GitHub 仓库 URL 规范化统一收敛至 `shared/validation.ts`。

## 4. 字段推断

### 来源优先级

`json-schema > known-template > example > readme > ai > heuristic`

每一层都运行；合并发生在 `label`、`description`、`type`、`required`、`default`、`enum`、约束、分组等属性级别。当前值只来自实际配置文件，示例默认值不会自动成为未保存修改。

### JSON Schema

- 支持配置中的 `$schema`、同目录 `{name}.schema.json` 与 `schema.json`。
- 支持本地相对引用、受控白名单远程 Schema（`https`、默认端口、无查询/片段、10 分钟内存缓存）、内部 `$ref` 与 `allOf` 合并。
- 提取类型、标题、描述、必填、枚举、默认值、数字范围、字符串长度与正则。

### 已知模板（中英双语）

- `package.json`
- `tsconfig.json` / `jsconfig.json`
- ESLint JSON 配置
- Prettier JSON 配置
- `docker-compose.yml` / `docker-compose.yaml` / `compose.yml` / `compose.yaml`（含顶层与服务级常用字段）
- `pyproject.toml`（PEP 621 / build-system / ruff / mypy / pytest）
- `Cargo.toml`（package / dependencies / features / workspace / release profile）
- 高频 `.env` 键（`PORT` / `HOST` / `NODE_ENV` / `DATABASE_URL` / `REDIS_URL` / `LOG_LEVEL` / `DEBUG` / `JWT_SECRET` / SMTP / S3 等）

### 示例

- 同时发现 `config.json.example` 和 `config.example.json` 等两类命名。
- 合并多个示例；支持嵌套字段、占位符必填判断和邻近注释。

### README

- 本地根目录优先，再检查 `docs/`。
- 本地不存在且有 GitHub URL 时调用 GitHub API。
- 支持 Markdown 表格、字段列表和对应格式的代码块。
- 同名嵌套叶子存在歧义时不做猜测性绑定。

### AI

- 用户配置任意 OpenAI `/chat/completions` 兼容供应商、Base URL、模型和 API Key。
- JSON mode 不兼容时自动回退普通响应。
- 配置、README 与示例内容有长度上限；大于 1 MB 的文件跳过 AI。
- 发送前递归屏蔽敏感键值、DSN、私钥、Authorization 头与供应商密钥。
- 字段旁的“AI 解读”必须由用户明确点击，只返回用途、填写建议和注意事项，不自动修改配置。

## 5. 桌面交互

### 开始页

- 文件夹路径与原生文件夹选择器。
- 可选 GitHub URL（实时校验并显示明确行内错误）。
- 最近 10 个项目全量展示，支持一键打开与单条移除。

### 项目侧栏

- 始终显示项目、文件数、格式、大小和当前文件。
- 文件名搜索与格式筛选可组合。
- 左侧文件列表（`role="listbox"`）支持 `ArrowUp` / `ArrowDown` / `Home` / `End` 键盘导航。
- 大文件状态与未保存状态点清晰可见。

### 编辑器

- 按分组呈现字段；支持文本、数字、整数（范围滑块）、枚举（保留展示非预设当前值）、开关、颜色、密码、可视化标量数组（增删/排序 + JSON 源码切换）与可视化平面键值表（增删 + JSON 源码切换）。
- 支持单字段「恢复原值」、`Ctrl+Z` / `Ctrl+Y` / `Ctrl+Shift+Z` 撤销重做历史栈、按格式校验的新增自定义配置项与删除已有配置项。
- 数值范围、整数安全范围、字符串长度、正则、必填与 JSON 语法实时校验。
- 已配置 AI 时，可按字段手动请求解释和填写建议；结果只展示在当前字段下，不会直接写入值。
- 表单与只读原始内容可切换；原始内容页提供行号与页内关键词搜索高亮、匹配计数和上下跳转。
- 存在 `.bak` 备份时提供「从 `.bak` 恢复」入口，弹出 Unified Diff 预览后原子恢复。
- `Ctrl+S` 保存，`Ctrl+O` 打开项目，`Ctrl+Z` 撤销，`Ctrl+Y` / `Ctrl+Shift+Z` 重做。

### 离开保护与无障碍

- 切换文件、设置、项目、重新扫描、重新加载前拦截未保存配置。
- 设置页自身有独立未保存保护。
- 关闭应用窗口时使用原生确认框拦截未保存配置或设置（随当前界面语言显示）。
- 外部文件修改显示持续横幅；保存与恢复时仍执行 hash 冲突检查。
- `Modal` 使用动态唯一 `id` 绑定 `aria-labelledby`/`aria-describedby`；浅色与深色主题文字对比度满足 WCAG AA（≥ 4.5:1）。

### 设置与国际化

- AI 启用开关与 OpenAI、DeepSeek、OpenRouter、Ollama、自定义供应商入口及连接测试。
- GitHub Token 安全存储与显式清除。
- 界面语言切换（简体中文 `zh-CN` / English `en-US`）实时预览并持久化。
- 外观主题（跟随系统 / 浅色 / 深色）实时预览并持久化。
- GitHub Release 手动更新检查。

## 6. 保存与恢复契约

1. Renderer 提交字段路径和值及打开时的 `FileVersion`。
2. 主进程重新读取文件并校验物理路径与 hash / size。
3. 主进程生成精确预览（含新增/修改/删除清单与完整输出文本）；Renderer 不可伪造最终输出。
4. 用户在逐字段差异或 Unified Diff 视图确认后，主进程再次校验版本并重新生成输出。
5. 先将原文件暂存为 `.bak.tmp`，写同目录临时文件，继承权限并原子替换目标（含 Windows `EPERM`/`EBUSY` 重试），再原子提升为 `.bak`。
6. `.bak` 恢复校验目标与 `.bak` 均为项目内普通文件、版本未漂移，并原子交换内容（旧目标内容写入新 `.bak`，保证可逆）。
7. 返回新版本，应用清除脏状态并抑制自己的监听事件。

JSONC、YAML、TOML、ENV、INI、Properties 均默认采用增量或原地保真策略；仅在 YAML 跨锚点别名或 TOML 复杂内联表/数组表无法安全原地补丁时，按需回退到全量序列化并在预览弹窗精确提示。

## 7. 验收门槛

发布前必须同时满足：

- `npm run typecheck` 无错误。
- `npm run test` 全通过，覆盖多格式注释保真、推断属性合并、新增模板、歧义保护、密钥屏蔽、设置加密与语言持久化、冲突保存、`.bak` 恢复、Unified Diff、i18n 零漏翻与端到端夹具全流程。
- `npm run build` 生产构建成功。
- `npm audit --omit=dev --audit-level=high --registry=https://registry.npmjs.org` 返回 0 高危漏洞。
- `node scripts/package.mjs` 生成有效 Windows x64 便携目录，资源中不包含 `core/`、`web/`、`tests/` 等源码目录。
- Git worktree 无测试产生的 `.bak`、`.tmp`、修改后 fixture 或未追踪临时文件。

## 8. 发布产物

`npm run package` 生成：

```text
release/Confui-win32-x64/
  Confui.exe
  *.dll
  locales/
  resources/
    app/
      package.json
      out/
```

这是便携目录，不是单文件程序；整个目录作为一个发布物分发。源代码、测试、文档和开发依赖不进入 `resources/app`。
