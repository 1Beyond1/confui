# 更新日志 (Changelog)

本文件记录 Confui 自 `v0.3.2` 以来的主要版本变更。版本号遵循 [Semantic Versioning](https://semver.org/) 规范。

## [v0.5.1] - 2026-11-26

### 修复 (Fixed)

- **多行引号 `.env` 全链路保真与脱敏**：
  - `core/formats/env.ts` 新增带单引号（`'`）、双引号（`"`）与反引号（`` ` ``）状态的 `groupEnvLines` 逻辑行分组解析，完整支持多行引号 `.env` 变量的读取、整组原地替换与整组删除，杜绝首行截断或残留孤立脏行；同步增强 `extractEnvComments` 注释提取以避免将多行值内部文本误判为注释。
  - `shared/diff.ts` 在 `DocumentMaskState` 新增 `envMultilineQuote` 状态，确保非 PEM 与混合 PEM 的多行引号 `.env` 密钥从第 2 行直至闭合引号在 `RawViewer`、`UnifiedDiffView` 与 `generateRedactedExport` 中全程遮罩。
- **全项目诊断 `parse-error` 跳转 `RawViewer` 与 JSON/JSONC 报错行号**：
  - `core/formats/json.ts` 在 `parseJsonc` 语法错误与重复键错误中补齐 1-based 行号（`at line N, column M` / `第 N 行`），使 `diagnoseProject` 能精准提取 JSON/JSONC 出错行号。
  - 新增受控只读源码通道 `confui:readRawFile`（严格遵循常规文件防符号链接校验、大小上限、UTF-8/二进制守卫与 INI 语法嗅探），点击诊断面板任意 `parse-error` 条目可直接降级打开只读 `RawViewer` 并定位高亮到 `focusLine`，且敏感值默认保持遮罩。
- **TOML 特殊浮点、大整数缩减保真与 4–5 连引号支持**：
  - `core/formats/toml.ts` 允许原值为 `inf` / `-inf` / `nan` 的 TOML 字段修改为合法有限数字。
  - 修正 `BigInt` 改为 JavaScript 安全整数范围值时与 `smol-toml` 重解析 `number` 类型不一致导致误触发全量 `stringifyToml` 清空注释的问题。
  - `scanTomlValueSpan` 补齐 TOML 1.0 规范紧邻 `"""` / `'''` 结束符前 1–2 个字面引号（4–5 连引号）的吞并逻辑，保护多行字符串注释保真与 `extractTomlComments` 注释提取。
- **项目内符号链接 `lstat` 校验加固**：
  - `core/paths.ts` 抽象公共 `resolveRegularProjectFile(root, relativePath)`（依次执行 `safeJoin` → `lstat(lexicalPath)` 拒绝符号链接与非普通文件 → `realpath` 校验项目根包含且 `samePath(resolvedPath, lexicalPath)`），统一替换 `core/save.ts` 全链路读写、备份、对比与导出入口的 `resolveExistingProjectPath` 调用。
- **局域网 HTTP AI Base URL 与锁死凭据防误清**：
  - 统一 `shared/validation.ts`、`core/settings.ts`、`web/src/SettingsPage.tsx` 与 `web/src/App.tsx` 策略：`canReuseStoredAiApiKey` 允许完全相同的非回环 `http` origin（如内网 Ollama/vLLM，仍严格拦截域名/端口变更、凭据/查询串/片段与 `https` → `http` 协议降级）复用既有加密 `apiKey`；且当 `provider` 与 `baseUrl` 完全未变更且 `clearSecrets.apiKey !== true` 时，切换主题/语言/SchemaStore 绝不清空既有密文或 `lockedSecrets`。
- **INI / Properties / 诊断边界收口**：
  - `core/formats/ini.ts` 修复 `preservedIniComment` 对非敏感 `//host/:...` `.npmrc` 键的死分支，统一复用 `isSensitiveIniAssignment`。
  - `core/formats/properties.ts` 在 `patchProperties` 与 `stringifyProperties` 增加非空及保留键安全校验，并兼容 Java `.properties` 行末无分隔符的裸键解析与原地补丁。
  - `core/diagnostics.ts` 优化对象数组 `missing-from-example`，避免因配套模板样例条数多于真实配置数组长度而产生误报；`web/src/App.tsx` 在诊断跳转未命中缓存文件列表时自动执行一次 `scanProject` 刷新再打开。

### 新增 (Added)

- **内置双语配置模板补齐**：`core/inference/known.ts` 新增 `launch.json` 与 `vercel.json` 完整中英双语内置模板（含 `configurations`、`compounds`、`inputs`、`rewrites`、`redirects`、`headers`、`crons` 对象数组 `itemFields` 定义），消除与文档清单的漂移。

## [v0.5.0] - 2026-11-23

### 新增 (Added)

- **全项目配置健康诊断面板**：支持顶栏与 `Ctrl+K` 一键并发扫描项目内全部可读配置文件，汇总 `parse-error`、`schema-violation`、`missing-from-example` 与零明文回显的 `plaintext-secret` 四类诊断条目，支持严重级别筛选与一键跳转定位。
- **应用数据区加密命名快照与对比回滚**：支持在 `userData/snapshots/<projectSha256>/` 以每快照随机 AES-256-GCM 密钥 + Electron `safeStorage` 加密保存命名快照（不向项目仓库写入额外文件），恢复前提供默认脱敏的 Unified Diff 预览并走主进程独立校验与原子写回链路。

### 修复 (Fixed)

- 支持 monorepo 子目录中的 `.env.*`、`.npmrc`、`.editorconfig`、`.eslintrc` 与 `.prettierrc` 识别、编辑、对比与脱敏导出。
- 主进程文件监听抑制升级为按规范化路径索引的并发安全 `Map`，补全 `mainWindow.isDestroyed()` 守卫。
- 修复 YAML 数字/布尔/十六进制/空值 Map 键原地编辑与删除问题，强化 ENV 与 INI 键名/节名注入校验。
- 收口诊断与快照红队复审缺陷（含解析错误上下文脱敏、嵌套 `dsn.password`/`url.api_token` 检出、Windows 8.3 短路径哈希规范化等）。

## [v0.4.0] - 2026-11-22

### 新增 (Added)

- **全格式注释推断与可选 SchemaStore 映射**：支持全 6 类配置格式的本地 AST/CST 注释提取（带递归密钥与 PEM 脱敏）以及默认关闭、按需开启的 SchemaStore（`json.schemastore.org` HTTPS 白名单 + 7 天本地缓存）远程 Schema 映射。
- **对象数组卡片、递归嵌套树与多文档 YAML**：新增可视化对象数组卡片编辑器、4 层递归嵌套对象树、标量数组列表与平面键值表，支持 `---` 多文档 YAML 独立切换与逐文档无损拼接保存。
- **跨文件脱敏配置搜索与 `Ctrl+K` 命令面板**：支持按键路径、非敏感值与注释全文检索，以及深层路径/卡片跳转。
- **模板初始化、多环境对比补齐与脱敏导出**：支持从 `.env.example` / `*.example` 安全创建配置文件（`open(..., "wx")` 拒覆盖与软链接）、多环境配置家族对比补齐、保留注释的脱敏模板导出。
- **完整中英双语（`zh-CN` / `en-US`）与无障碍打磨**：实现全量界面与内置模板双语化、Unified Diff 源码预览与默认敏感值掩码、`.bak` 一键恢复、`Ctrl+Z` / `Ctrl+Y` 撤销重做栈、首页拖拽打开文件夹与 `RawViewer` 虚拟滚动。

### 修复 (Fixed)

- 重构拆分多格式引擎与前端主组件，收敛 `shared/validation.ts` 唯一校验真源，升级 `smol-toml` 至 `1.9.1` 清零高危依赖漏洞。
- 强化 Electron 沙盒与安全边界、ReDoS 静态正则防护、跨 hunk / 多格式敏感值脱敏与 AI Base URL 来源隔离。

## [v0.3.2] - 2026-09-01

### 修复 (Fixed)

- 加固多格式解析与写回边界条件（含 JSON Schema 拉取与引用解析、原子保存与父子路径冲突检测、AI 敏感信息脱敏盲区及 Windows 便携包确定性打包）。
- 完善推断默认值显式触发、字段按需 AI 解读与大配置文件保护机制。
