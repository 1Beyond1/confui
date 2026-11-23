<p align="right"><strong>简体中文</strong> | <a href="README.en.md">English</a></p>

# Confui

Confui 是一个 Windows x64 桌面配置编辑器。选择本地项目后，它会发现配置文件、组合项目中的 JSON Schema / 内置模板 / 可选 SchemaStore / 文件注释 / 示例 / README / 可选 AI 信息，并把字段转换成可校验、支持撤销重做、对象数组卡片与嵌套树编辑的桌面表单。用户确认逐字段差异或 Unified Diff 源码差异后，Confui 才会原子写回原文件并保留 `.bak` 备份（同时支持应用外加密命名快照与一键回滚）。设置页支持切换中英文界面、开启 SchemaStore 远程映射与手动检查 GitHub Release 更新。

![Confui v0.5.0 桌面配置编辑器主界面](assets/confui-preview.png)

<p align="center"><em>Confui v0.5.0 桌面表单编辑器（浅色主题 · 多层推断来源标注 · 支持一键从 <code>.bak</code> 或命名快照恢复）</em></p>

| 保存确认与 Unified Diff 源码差异预览 | 深色主题与英文界面 |
| :---: | :---: |
| ![Confui v0.5.0 保存确认与 Unified Diff 源码差异预览](assets/confui-unified-diff.png) | ![Confui v0.5.0 深色主题与英文界面](assets/confui-dark-en.png) |

## 社区

本项目已链接 LINUX DO 社区，欢迎在社区交流使用体验和反馈：[开源推广帖子](https://linux.do/t/topic/2614137)。

## 核心特性

- **多格式注释与多文档 YAML 保真**：JSON / JSONC（AST 增量）、YAML（`yaml` v2 CST 增量，支持 `---` 多文档独立切换与逐文档无损保存，识别 K8s `kind/metadata.name` 与 Spring Boot `on-profile` 标签，未改动文档 100% 字节级保留）、TOML（原地补丁 + `smol-toml` 校验）、ENV / INI（含 `.editorconfig` 与 `.npmrc` 原生识别）/ Java Properties（逐行保真），同时支持 monorepo 子目录中的 `.env.*` / `.npmrc` / `.editorconfig` / `.eslintrc` / `.prettierrc`。
- **全项目配置健康诊断面板（v0.5.0）**：顶栏与 `Ctrl+K` 命令面板一键扫描当前项目全部可读配置文件（受控并发、字节上限与物理路径校验），集中汇总四类问题：① 语法/解析错误（`parse-error`）；② JSON Schema / 内置模板校验违规（必填缺失、类型不匹配、范围/长度/枚举/正则越界）；③ 相对配套 `.env.example` / `*.example` 缺失的键（`missing-from-example`）；④ 疑似明文敏感值提示（仅报位置与键名，绝不返回或展示明文密钥）。支持按错误 / 警告 / 提示筛选并一键跳转打开目标文件、滚动高亮目标字段。
- **应用数据区命名快照与对比回滚（v0.5.0）**：在编辑器工具栏或 `Ctrl+K` 一键为当前文件保存带备注标签、时间戳与 SHA-256 的命名快照；快照经 AES-256-GCM + Electron `safeStorage` 加密存储在应用数据区 `userData/snapshots/<projectSha256>/`（单项目上限 50 份、单文件上限 5 MB，绝不向用户项目仓库写入任何额外文件）。恢复前复用 Unified Diff 预览（敏感字段默认掩码 `••••••••`），并经主进程校验后通过 `commitSave` 原子写回且保留 `.bak`。
- **全项目跨文件搜索与 `Ctrl+K` 命令面板**：并发解析项目内可读配置，按键路径、非敏感值与注释全文检索，支持当前文件嵌套路径与对象数组卡片深度跳转；敏感字段命中强制脱敏仅标位置，并聚合健康诊断、命名快照、保存、恢复 `.bak`、对比补齐、导出脱敏、重扫与主题/语言切换。
- **模板引导初始化、多环境对比补齐与脱敏导出**：扫描器自动识别未配对示例模板（如 `.env.example`、`config.example.jsonc/yaml/toml`）并在侧栏提供一键安全创建（`open(..., "wx")` 严禁覆盖、拒软链接）；自动归组多环境配置（如 `.env` + `.env.production`、`app.yaml` + `app-prod.yaml`），支持多文档 YAML 选择与跨文件结构化键值对比补齐，以及保留注释格式的「导出脱敏模板/分享副本」。
- **对象数组卡片、递归嵌套树与大文件体验**：支持对象数组可视化卡片编辑器（自动提取卡片标题与摘要徽章、复制/排序、单卡片 JSON 切换、按 Schema `items.properties` 渲染控件）、递归嵌套对象树（最多 4 层展开 + 深层结构化 JSON 块回退）、标量数组列表与平面键值表；支持分组折叠、状态筛选胶囊（全部 / 已修改 / 有错误 / 必填）、`Ctrl+Z` / `Ctrl+Y` 撤销重做栈、首页拖拽文件夹打开项目，以及原始内容页固定行高虚拟滚动窗口与页内搜索。
- **可核对的安全写回与双语支持**：保存前支持切换「逐字段差异（新增/修改/删除）」与「Unified Diff 源码差异」（默认对 `secret` 字段值脱敏掩码 `••••••••` 并提供显式显示/隐藏开关）；自动创建 `.bak` 备份并通过同目录临时文件原子替换（含 Windows `EPERM`/`EBUSY` 重试）；完整简体中文 / English 双语支持。

## 支持范围

| 格式 | 读取 | 保存策略 |
| --- | --- | --- |
| JSON / JSONC | 支持注释、尾随逗号、重复键拒绝（含 `.eslintrc` / `.prettierrc`） | `jsonc-parser` AST 增量编辑，保留注释、缩进与键顺序 |
| YAML / YML | `yaml` v2 完整解析；支持 `---` 多文档切换、数字/布尔 Map 键与共享锚点，拒绝循环引用 | CST 增量写回，多文档仅改写当前文档 span，保留注释、缩进、键顺序与特殊标量；仅在跨锚点别名等复杂情况按需回退并提示 |
| TOML | `smol-toml` 完整解析（保留 `TomlDate`、大整数与 `inf`/`nan`），支持 `#:schema` 指令 | 原地源码补丁引擎，保留注释、空行与表头顺序；仅在复杂内联表或数组表修改时按需回退并提示 |
| ENV | 支持 `export`、引号、多行转义与行尾注释（含子目录 `.env.*`） | 逐行修改，底层强制校验变量名规范，保留相邻注释与引号风格 |
| INI / CFG / CONF | 严格 INI 语法（节与键、`=` / `:`、`key[]` 数组、多级点分节），原生支持 `.editorconfig` 与 `.npmrc`；nginx/httpd/redis 指令式 `.conf`/`.cfg` 标记为不支持 | 逐行修改，禁止非法 `=`/换行/控制字符键名，保留注释与节结构 |
| Java Properties | 支持转义键与反斜杠续行 | 逐行逻辑替换，保留相邻注释 |

JavaScript / TypeScript 配置文件不会被伪装成 JSON 打开。范例文件、锁文件、Schema 文件、备份文件和构建目录也不会出现在可编辑列表里。

## 推断顺序

每一层都可以为同一个字段贡献不同属性，合并单位是字段属性，而不是整条字段：

1. **JSON Schema**：支持 JSON `$schema`、YAML `# yaml-language-server: $schema=...`、TOML `#:schema ...`、同目录 `{name}.schema.json`、`schema.json`、本地引用、白名单远程拉取、`$ref`、`allOf` / `anyOf` / `oneOf` 与 `items.properties`
2. **内置常见配置模板**（中英双语）：`package.json`、`tsconfig.json` / `jsconfig.json`、ESLint、Prettier、`docker-compose.yml` / `compose.yaml`、`pyproject.toml`、`Cargo.toml`、`launch.json`、`vercel.json` 及高频 `.env` 键
3. **SchemaStore 远程映射**（可选，默认关闭）：在设置页显式启用后，按文件名匹配官方 SchemaStore 规范（`json.schemastore.org` HTTPS 白名单 + 7 天本地磁盘缓存），表单顶部标注来源
4. **文件注释提取**：基于全格式 AST/CST 提取字段上方与行尾注释作为字段说明（经递归密钥脱敏，过滤多行 PEM 与凭据特征）
5. **示例文件**：`*.example` / `*.sample` / `*.template` / `*.dist` / `*.default`
6. **README 文档**：本地根目录 / `docs/` 优先；本地缺失且提供有效 GitHub 链接时回退到 GitHub README API
7. **AI 字段分析**（可选）：用户配置的任意 OpenAI 兼容 `/chat/completions` 服务
8. **结构推断**：基于当前值形态与键名启发式推断

例如，Schema 可以提供整数范围或对象数组结构，内置模板、文件注释或 README 提供说明，示例文件提供默认值，而当前文件始终提供实际值。默认值不会自动写入；字段为空时可以手动点击“使用默认值”。

当某个字段仍然看不懂时，可以在字段旁手动点击“AI 解读”，让已配置的供应商解释用途、填写方式和注意事项。这个操作不会自动修改配置；发送前仍会递归屏蔽敏感值。

## 保存与数据安全

- Renderer 开启 `contextIsolation` 与 `sandbox`、关闭 `nodeIntegration`，只能通过 `contextBridge` 调用白名单 IPC，没有 HTTP 后端。
- 所有读写、诊断、快照采集与 `.bak` 恢复路径均在主进程做物理路径（`realpath` + `lstat`）校验，严格限制在用户选择的项目目录内并拒绝符号链接逃逸。
- 保存前展示逐字段差异与 Unified Diff 源码对比（敏感值默认掩码 `••••••••` 且可显式切换），并再次在主进程独立重算输出文本（不信任 Renderer 传入文本）。
- 命名快照经 AES-256-GCM + Electron `safeStorage` 加密保存在应用数据区 `userData/snapshots/<projectSha256>/`，恢复时主进程独立解密并校验 SHA-256 完整性，再走原子替换 + `.bak` 链路，绝不污染项目工作树。
- 配置健康诊断与跨文件搜索限制并发度、总字节与结果条数；明文敏感值提示与敏感键命中仅返回位置和键名，绝不暴露明文密钥值。
- 模板初始化严格校检物理路径与父目录链路，通过 `open(..., "wx")` 原子创建、严禁覆盖已有文件。
- 保存与恢复时双重校验文件 SHA-256 hash，采用临时文件原子替换并复用 Windows `EPERM`/`EBUSY` 退避重试，再原子提升 `.bak`。
- API Key 与 GitHub Token 使用 Electron `safeStorage` 加密存储，主进程返回渲染进程时强制脱敏；发给 AI 的配置与文档递归屏蔽密码、Token、私钥、DSN、Authorization 头与供应商密钥。

## 开发

要求 Node.js 22.12+，在 Windows PowerShell 中运行：

```powershell
npm ci
npm run dev
```

完整检查（类型检查 + 全部单元/集成/E2E 测试 + 生产构建）：

```powershell
npm run check
```

单独运行端到端与 UI 集成测试：

```powershell
npm run test:e2e
```

生产依赖安全审计（要求 0 高危漏洞）：

```powershell
npm audit --omit=dev --audit-level=high --registry=https://registry.npmjs.org
```

生成便携桌面应用：

```powershell
npm run package
```

输出位于 `release/Confui-win32-x64/Confui.exe`。发布时请把整个 `Confui-win32-x64` 目录压缩成 ZIP，不要只上传 EXE；需要保留同目录的 DLL、`locales` 与 `resources`，它不是单文件程序。当前发布目标是 Windows x64，设置页的更新检查会打开 Release 下载页，下载后仍需手动替换旧目录。

## 目录

```text
core/
  formats/        多格式解析与写回引擎（json / yaml / toml / env / ini / properties）
  inference/      8 层推断引擎（JSON Schema / 内置模板 / SchemaStore / 文件注释 / 示例 / README / AI / 启发式）
  ai/             OpenAI 兼容 AI 客户端与连接测试
  scanner.ts      流式项目扫描、未配对示例模板识别与多环境分组
  search.ts       受控并发的跨文件脱敏配置检索引擎
  diagnostics.ts  全项目配置健康诊断引擎（语法 / Schema / 示例缺失 / 明文敏感位置提示）
  snapshots.ts    应用数据区加密命名快照存储与校验恢复引擎
  save.ts         差异预览、原子保存、.bak 恢复、模板初始化、多环境对比补齐与脱敏导出
  settings.ts     设置规范化、Windows 写入重试与 safeStorage 凭据加密
electron/         主进程、窗口生命周期、CSP、文件监听与安全 Preload 桥
shared/           IPC / Schema 类型契约、共享校验真源与 LCS Unified Diff 引擎
web/src/          Preact 桌面界面（components / hooks / i18n / utils）
tests/            单元、端到端（e2e-project）与 UI 状态集成测试
scripts/          确定性 Windows x64 便携打包脚本
```

更多工程协作与架构边界说明见 [AGENTS.md](AGENTS.md) 与 [PROJECT_SPEC.md](PROJECT_SPEC.md)。

## 网络行为

Confui 只在下面四种情况下联网，其余功能完全本地：

| 场景 | 目标 | 触发条件 |
| --- | --- | --- |
| 补充文档 | GitHub README API | 本地 README 缺失，且项目填写了有效的 GitHub 链接 |
| 拉取显式远程 Schema | 仅 `json.schemastore.org`、`schemastore.org`、`raw.githubusercontent.com`、`unpkg.com`、`cdn.jsdelivr.net` | 配置文件声明了指向以上域名的 `https` `$schema` 或 YAML/TOML Schema 指令 |
| SchemaStore 自动映射 | 仅 `json.schemastore.org` | 在设置页手动开启 SchemaStore 开关后，匹配常见文件名并缓存 7 天 |
| 检查更新 | GitHub Release API | 在设置页手动点击检查 |

远程 Schema 只接受 `https`、默认端口、无查询参数或片段，并且域名必须在白名单列表中；其他地址会被跳过并在界面给出提示。AI 请求只发往用户自己配置的 Base URL（必须是 `http` 或 `https`，且不允许把用户名或密码写进 URL）。

## 已知边界

- GitHub 链接只用于本地 README 缺失时补充文档；编辑仍需要本地项目文件夹。
- YAML 与 TOML 常规编辑均完整保留注释与排版；当编辑涉及 YAML 锚点别名展开或 TOML 复杂内联表/数组表结构时，会安全回退到全量序列化并在预览弹窗明确提示。
- YAML 的共享锚点可以读取；如果配置通过锚点形成循环引用，会为避免表单崩溃而拒绝打开。
- SchemaStore 与 AI 均为可选增强层；默认离线模式下其余本地推断与诊断能力均可完整工作。
- 打包产物没有代码签名，首次运行时 Windows SmartScreen 可能提示“未知发布者”。

## 许可证

[MIT](LICENSE)
