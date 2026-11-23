# Confui 0.5 产品与验收规格

## 1. 产品目标

Confui 面向经常下载、试用开源项目以及维护多环境配置的开发者。用户选择本地项目后，应用应完成五件事：

1. 准确发现项目根目录及 monorepo 子目录中真正可编辑的配置文件。
2. 尽可能解释字段的用途、类型、约束、默认值、嵌套结构与敏感性。
3. 用合适的桌面控件编辑（含对象数组卡片、递归嵌套树、标量数组/键值表、多文档 YAML 切换、撤销重做、新增/删除键），并在输入阶段阻止明显错误。
4. 提供全项目配置健康诊断，快速发现解析错误、Schema 校验违规、配套 `.env.example` / `*.example` 缺失项与明文敏感值风险位置。
5. 在不静默覆盖外部修改、不破坏注释排版、不泄露凭据的前提下安全写回文件，并支持 `.bak` 一键恢复与应用数据区加密命名快照回滚。

Confui 不是代码配置执行器，不解析或改写 `vite.config.ts`、`next.config.js` 等可执行源码；也不是远程仓库编辑器。

## 2. 当前范围

### 输入

- 本地项目文件夹：必选，是扫描、诊断和编辑的数据源。
- GitHub 仓库链接：可选，仅在本地 README 缺失时作为文档回退；非法链接在首页给出明确行内校验提示。
- 本地 `.git/config` 中的 GitHub remote：可自动识别。

### 配置格式

- JSON / JSONC（AST 增量写回，支持注释与尾随逗号，拒绝重复键，支持 `.eslintrc` / `.prettierrc` 及子目录变体）
- YAML / YML（`yaml` v2 CST 增量保真，支持 `---` 多文档独立切换与逐文档无损拼接、数字/布尔 Map 键就地编辑与删除、K8s `kind/name` 与 Spring Boot `on-profile` 标签，拒绝循环引用）
- TOML（`smol-toml` 校验 + 源码原地补丁保真，支持 `#:schema` 指令，保留注释/空行/表头顺序，复杂结构按需回退并提示）
- ENV（逐行保真，支持 `export`、引号、多行转义与行尾注释，支持子目录 `.env.*`，底层强制校验 `/^[A-Za-z_][A-Za-z0-9_]*$/` 变量名）
- INI / CFG / CONF（逐行保真，支持 `=` / `:`、`key[]` 数组与多级点分节，原生支持 `.editorconfig` 与 `.npmrc` 含子目录路径；禁止 `=`/换行/控制字符非法键名；拒开非 INI 指令式 `.conf`/`.cfg`）
- Java Properties（逻辑行保真，支持转义键与反斜杠续行）

### 不扫描

- 锁文件、Schema、示例文件（归入“可初始化模板”）、备份文件（`*.bak`）
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
core modules (formats/ | inference/ | ai/ | scanner | search | diagnostics | snapshots | save | settings | paths | files)
      |
shared contracts & pure utilities (schema.ts | validation.ts | diff.ts)
```

- 无 Fastify、无本地端口、无 HTTP 后端。
- Renderer 开启 `contextIsolation` 和 `sandbox`，关闭 `nodeIntegration`，生产环境强制 CSP。
- Preload 以 sandbox 兼容的 CommonJS 产物加载。
- 所有 IPC 返回统一的 `Result<T>`，错误包含稳定 code 与用户可读说明。
- 十六进制颜色正则、原型污染危险键黑名单、敏感键/密钥特征规则、ReDoS 安全正则校验与 GitHub 仓库 URL 规范化统一收敛至 `shared/validation.ts`。

## 4. 字段推断

### 来源优先级（8 层）

`json-schema > known-template > schemastore > comment > example > readme > ai > heuristic`

每一层都运行；合并发生在 `label`、`description`、`type`、`required`、`default`、`enum`、约束、分组、`itemFields` 等属性级别。当前值只来自实际配置文件，示例默认值不会自动成为未保存修改。

### JSON Schema 与 SchemaStore

- 支持 JSON `$schema`、YAML `# yaml-language-server: $schema=...`、TOML `#:schema ...`、同目录 `{name}.schema.json` 与 `schema.json`。
- 支持本地相对引用、受控白名单远程 Schema（`https`、默认端口、无查询/片段）、内部 `$ref`（含 DAG 记忆化与步数上限）、`allOf` / `anyOf` / `oneOf` 合并与 `items.properties` 对象数组字段提取。
- **SchemaStore 远程映射**（默认关闭，离线优先）：在设置页显式启用后，按常见文件名匹配 `json.schemastore.org` 规范并本地缓存 7 天，表单顶部显示来源标签。

### 已知模板（中英双语）

- `package.json`、`tsconfig.json` / `jsconfig.json`、ESLint、Prettier
- `docker-compose.yml` / `docker-compose.yaml` / `compose.yml` / `compose.yaml`（含顶层与服务级常用字段）
- `pyproject.toml`、`Cargo.toml`、`launch.json`、`vercel.json`
- 高频 `.env` 键（`PORT` / `HOST` / `NODE_ENV` / `DATABASE_URL` / `REDIS_URL` / `LOG_LEVEL` / `DEBUG` / `JWT_SECRET` / SMTP / S3 等）

### 文件注释、示例、README 与 AI

- **文件注释（`comment`）**：全格式 AST/CST 提取字段上方与行尾注释作为字段说明，提取结果强制经密钥特征与多行 PEM 过滤脱敏。
- **示例文件（`example`）**：同时发现 `config.json.example` 和 `config.example.json` 等命名；合并多个示例，支持嵌套字段、占位符必填判断与邻近注释。
- **README（`readme`）**：本地根目录优先，再检查 `docs/`；本地不存在且有 GitHub URL 时回退 GitHub API；同名嵌套叶子存在歧义时不做猜测性绑定。
- **AI（`ai`）**：用户配置任意 OpenAI `/chat/completions` 兼容供应商；发送前递归屏蔽敏感键值与密钥特征；大于 1 MB 文件跳过 AI；字段旁“AI 解读”仅由用户显式点击触发。

## 5. 桌面交互与 v0.5.0 核心能力

### 开始页与项目侧栏

- 文件夹路径、原生选择器与拖拽文件夹打开项目；可选 GitHub URL 行内校验；最近 10 个项目一键打开与单条移除。
- 左侧文件列表支持搜索、格式筛选与键盘导航；未配对示例模板支持侧栏一键安全创建（`open(..., "wx")`）。

### 编辑器与结构化控件

- 按分组呈现字段；支持文本、数字、整数滑块（含精确数字输入）、枚举、开关、颜色、敏感值掩码输入。
- **对象数组卡片**：自动识别对象数组并生成可折叠卡片，提取非敏感标题与摘要徽章，支持卡片增删、复制、上下排序、单卡片 JSON 切换与基于 Schema `itemFields` 的表单控件。
- **递归嵌套对象树**：支持最多 4 层可折叠嵌套树编辑（支持新增字符串/数字/布尔/子对象），超过 4 层自动切换为带敏感遮罩保护的结构化 JSON 块。
- **多文档 YAML**：检测到多 `---` 文档时顶部展示文档切换标签页，仅修改当前选中文档，其余兄弟文档字节级保留，且敏感字段元数据按文档隔离。
- 支持单字段恢复、`Ctrl+Z` / `Ctrl+Y` 撤销重做栈、按格式校验的新增/删除键、跨文件环境对比补齐、脱敏导出与虚拟滚动原始内容视图。

### 全项目配置健康诊断面板（v0.5.0）

- 顶栏与 `Ctrl+K` 提供快捷入口，经 `confui:diagnoseProject` 并发扫描当前项目全部可读配置文件（受控并发、字节上限、物理路径与软链接校验）。
- 汇总四类问题：
  1. `parse-error`（错误）：语法或解析失败，错误详情经脱敏清洗；
  2. `schema-violation`（错误）：JSON Schema / 内置模板规则违规（必填缺失、类型不匹配、范围/长度/枚举/安全正则越界）；
  3. `missing-from-example`（警告）：相对配套 `.env.example` / `*.example` 缺失的配置键；
  4. `plaintext-secret`（提示）：疑似明文敏感值提醒，**仅报告文件、行号与键名，绝不返回或展示明文密钥值**。
- 支持按全部 / 错误 / 警告 / 提示筛选与关键词过滤，点击任意条目直接打开目标文件并滚动高亮目标字段（受未保存修改保护）。

### 应用数据区命名快照历史与对比回滚（v0.5.0）

- 编辑器工具栏与 `Ctrl+K` 提供快捷入口，经 `confui:listSnapshots` / `confui:saveSnapshot` / `confui:previewSnapshotRestore` / `confui:deleteSnapshot` 管理命名快照。
- 快照存储在应用数据区 `userData/snapshots/<projectSha256>/`，采用每快照随机 AES-256-GCM 密钥 + Electron `safeStorage` 封装加密，限制单项目最多 50 份、单文件上限 5 MB、快照 ID 严格校验防路径穿越，**绝不向用户项目仓库写入任何额外文件**。
- 恢复快照时先展示与当前磁盘文件的 Unified Diff 预览（敏感值默认掩码 `••••••••`），确认后由主进程独立解密并校验 SHA-256 与语法，再经 `commitSave` 原子替换原文件并自动保留 `.bak`。

### 离开保护、设置与无障碍

- 切换文件、YAML 文档、设置、项目、重扫或重载前拦截未保存更改；弹窗在忙碌态阻断 `Escape` 与遮罩关闭并具备卸载取消守卫。
- 外部文件修改显示持续横幅；主进程文件监听抑制按规范化路径 Map 索引，避免多文件事件并发竞态。
- 支持简体中文（`zh-CN`）与 English（`en-US`）双语界面、浅色/深色/跟随系统主题与手动 GitHub Release 更新检查。

## 6. 保存与恢复契约

1. Renderer 提交字段路径和值（或经预览生成的快照恢复引用）及打开时的 `FileVersion`。
2. 主进程重新读取文件并校验物理路径（`realpath` + `lstat`）与 hash / size。
3. 主进程独立生成或从 `SnapshotStore` 解密校验输出文本；Renderer 不可伪造最终输出。
4. 用户在逐字段差异或 Unified Diff 视图确认后，主进程再次校验版本与内容一致性。
5. 先将原文件暂存为 `.bak.tmp`，写同目录临时文件，继承权限并原子替换目标（含 Windows `EPERM`/`EBUSY` 重试），再原子提升为 `.bak`。
6. `.bak` 恢复校验目标与 `.bak` 均为项目内普通文件、版本未漂移，并原子交换内容（旧目标内容写入新 `.bak`，保证可逆）。
7. 返回新版本，应用更新状态并按规范化路径抑制自身的监听事件。

## 7. 验收门槛

发布前必须同时满足：

- `npm run typecheck` 无错误。
- `npm run test` 全通过，覆盖多格式注释保真、monorepo 子目录点文件、YAML 非字符串键、ENV/INI 键名安全校验、全项目诊断（含零明文泄露）、应用外加密命名快照与回滚、冲突保存、`.bak` 恢复、Unified Diff、i18n 零漏翻与端到端夹具全流程。
- `npm run build` 生产构建成功。
- `npm run test:e2e` 全部通过。
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
