<p align="right"><strong>简体中文</strong> | <a href="README.en.md">English</a></p>

# Confui

Confui 是一个 Windows x64 桌面配置编辑器。选择本地项目后，它会发现配置文件、组合项目中的 Schema / 内置模板 / 示例 / README / 可选 AI 信息，并把字段转换成可校验、支持撤销重做与差异核对的桌面表单。用户确认逐字段差异或 Unified Diff 源码差异后，Confui 才会原子写回原文件并保留 `.bak` 备份（支持一键回滚）。设置页支持切换中英文界面与手动检查 GitHub Release 更新。

![Confui 配置编辑器界面](assets/confui-preview.png)

## 社区

本项目已链接 LINUX DO 社区，欢迎在社区交流使用体验和反馈：[开源推广帖子](https://linux.do/t/topic/2614137)。

## 核心特性

- **多格式注释与排版保真**：JSON / JSONC（AST 增量）、YAML（`yaml` v2 CST 增量）、TOML（原地补丁 + `smol-toml` 校验）、ENV / INI / Java Properties（逐行保真）。
- **结构化编辑体验**：标量数组支持逐行增删与上下排序，平面对象支持键值表增删，并可一键切换 JSON 源码模式；支持单字段恢复原值、`Ctrl+Z` / `Ctrl+Y` 撤销重做栈、按格式校验新增/删除自定义配置项。
- **可核对的安全写回与回滚**：保存前支持切换「逐字段差异（新增/修改/删除）」与「Unified Diff 源码差异」；自动创建 `.bak` 备份并通过同目录临时文件原子替换；编辑器内提供「从 `.bak` 恢复」入口与差异预览。
- **原始内容检索与无障碍打磨**：原始内容页提供行号与页内关键词搜索高亮；左侧文件列表支持方向键 / `Home` / `End` 键盘导航；深浅色主题均满足 WCAG AA 对比度标准；内置简体中文 / English 双语切换。

## 支持范围

| 格式 | 读取 | 保存策略 |
| --- | --- | --- |
| JSON / JSONC | 支持注释、尾随逗号、重复键拒绝 | `jsonc-parser` AST 增量编辑，保留注释、缩进与键顺序 |
| YAML / YML | `yaml` v2 完整解析；支持共享锚点，拒绝循环引用 | CST 增量写回，保留注释、缩进、键顺序与特殊标量；仅在跨锚点别名等复杂情况按需回退并提示 |
| TOML | `smol-toml` 完整解析（保留 `TomlDate`、大整数与 `inf`/`nan`） | 原地源码补丁引擎，保留注释、空行与表头顺序；仅在复杂内联表或数组表修改时按需回退并提示 |
| ENV | 支持 `export`、引号、多行转义与行尾注释 | 逐行修改，保留相邻注释与引号风格 |
| INI / CFG / CONF | 仅限 INI 语法（节与键、`=` / `:`、`key[]` 数组）；nginx、httpd、redis 这类指令式 `.conf` / `.cfg` 会被标记为不支持 | 逐行修改，保留注释与节结构 |
| Java Properties | 支持转义键与反斜杠续行 | 逐行逻辑替换，保留相邻注释 |

JavaScript / TypeScript 配置文件不会被伪装成 JSON 打开。范例文件、锁文件、Schema 文件、备份文件和构建目录也不会出现在可编辑列表里。

## 推断顺序

每一层都可以为同一个字段贡献不同属性，合并单位是字段属性，而不是整条字段：

1. **JSON Schema**：支持 `$schema`、同目录 `{name}.schema.json`、`schema.json`、本地引用、受控远程拉取、`$ref` 与 `allOf`
2. **内置常见配置模板**（中英双语）：`package.json`、`tsconfig.json` / `jsconfig.json`、ESLint、Prettier、`docker-compose.yml` / `compose.yaml`、`pyproject.toml`、`Cargo.toml` 及高频 `.env` 键（`PORT` / `HOST` / `NODE_ENV` / `DATABASE_URL` / `REDIS_URL` / `LOG_LEVEL` 等）
3. **示例文件**：`*.example` / `*.sample` / `*.template` / `*.dist` / `*.default`
4. **README 文档**：本地根目录 / `docs/` 优先；本地缺失且提供有效 GitHub 链接时回退到 GitHub README API
5. **AI 字段分析**（可选）：用户配置的任意 OpenAI 兼容 `/chat/completions` 服务
6. **结构推断**：基于当前值形态与键名启发式推断

例如，Schema 可以提供整数范围，内置模板或 README 提供说明，示例文件提供默认值，而当前文件始终提供实际值。默认值不会自动写入；字段为空时可以手动点击“使用默认值”。

当某个字段仍然看不懂时，可以在字段旁手动点击“AI 解读”，让已配置的供应商解释用途、填写方式和注意事项。这个操作不会自动修改配置；发送前仍会递归屏蔽敏感值。

## 保存安全

- Renderer 开启 `contextIsolation` 与 `sandbox`、关闭 `nodeIntegration`，只能通过 `contextBridge` 调用白名单 IPC，没有 HTTP 后端。
- 所有读写与 `.bak` 恢复路径均在主进程做物理路径（`realpath` + `lstat`）校验，严格限制在用户选择的项目目录内并拒绝符号链接逃逸。
- 保存前展示逐字段差异与 Unified Diff 源码对比，并再次在主进程重新生成最终文本（不信任 Renderer 传入文本）。
- 保存与恢复时双重校验文件 SHA-256 hash，拒绝覆盖外部修改。
- 写入前先暂存备份并通过同目录临时文件原子替换（含 Windows `EPERM`/`EBUSY` 重试），再原子提升为 `.bak`。
- 异常大的配置最多展示 2,000 个优先级最高的字段；流式目录扫描限制单次最多处理 50,000 个目录项、4,000 个配置文件。
- API Key 与 GitHub Token 使用 Electron `safeStorage` 加密存储，主进程返回渲染进程时强制脱敏（仅返回状态与掩码提示）；系统安全存储不可用时保留原密文、不会被空值覆盖。
- 发给 AI 的配置与文档会递归屏蔽 Token、密码、私钥、DSN、Authorization 头与常见供应商密钥。

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
  formats/    多格式解析与写回引擎（json / yaml / toml / env / ini / properties）
  inference/  6 层推断引擎（JSON Schema / 内置模板 / 示例 / README / AI / 启发式）
  ai/         OpenAI 兼容 AI 客户端与连接测试
  scanner.ts  流式项目扫描与格式识别
  save.ts     差异预览、原子保存与 .bak 一键恢复
  settings.ts 设置规范化与 safeStorage 凭据加密
electron/     主进程、窗口生命周期、CSP、文件监听与安全 Preload 桥
shared/       IPC / Schema 类型契约、共享校验真源与 LCS Unified Diff 引擎
web/src/      Preact 桌面界面（components / hooks / i18n / utils）
tests/        单元、端到端（e2e-project）与 UI 状态集成测试
scripts/      确定性 Windows x64 便携打包脚本
```

更多工程协作与架构边界说明见 [AGENTS.md](AGENTS.md) 与 [PROJECT_SPEC.md](PROJECT_SPEC.md)。

## 网络行为

Confui 只在下面三种情况下联网，其余功能完全本地：

| 场景 | 目标 | 触发条件 |
| --- | --- | --- |
| 补充文档 | GitHub README API | 本地 README 缺失，且项目填写了有效的 GitHub 链接 |
| 拉取远程 JSON Schema | 仅 `json.schemastore.org`、`schemastore.org`、`raw.githubusercontent.com`、`unpkg.com`、`cdn.jsdelivr.net` | 配置文件声明了指向以上域名的 `https` `$schema` |
| 检查更新 | GitHub Release API | 在设置页手动点击检查 |

远程 `$schema` 只接受 `https`、默认端口、无查询参数或片段，并且域名必须在上述列表中；其他地址会被跳过并在界面给出提示。拉取结果在内存中缓存 10 分钟。AI 请求只发往用户自己配置的 Base URL（必须是 `http` 或 `https`，且不允许把用户名或密码写进 URL）。

## 已知边界

- GitHub 链接只用于本地 README 缺失时补充文档；编辑仍需要本地项目文件夹。
- YAML 与 TOML 常规编辑均完整保留注释与排版；当编辑涉及 YAML 锚点别名展开或 TOML 复杂内联表/数组表结构时，会安全回退到全量序列化并在预览弹窗明确提示。
- YAML 的共享锚点可以读取；如果配置通过锚点形成循环引用，会为避免表单崩溃而拒绝打开。
- AI 是可选的最后回退层；未配置供应商时，其余推断能力仍可正常工作。
- 打包产物没有代码签名，首次运行时 Windows SmartScreen 可能提示“未知发布者”。

## 许可证

[MIT](LICENSE)
