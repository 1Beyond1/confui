# Confui

Confui 是一个 Windows x64 桌面配置编辑器。选择本地项目后，它会发现配置文件、组合项目中的 Schema / 示例 / README 信息，并把字段转换成可校验的表单。用户确认差异后，Confui 才会写回原文件。设置页支持手动检查 GitHub Release 更新。

![Confui 配置编辑器界面](assets/confui-preview.png)

## 社区

本项目已链接 LINUX DO 社区，欢迎在社区交流使用体验和反馈：[开源推广帖子](https://linux.do/t/topic/2614137)。

## 支持范围

| 格式 | 读取 | 保存策略 |
| --- | --- | --- |
| JSON / JSONC | 支持注释、尾随逗号 | AST 增量编辑，保留注释、缩进和键顺序 |
| ENV | 支持 `export`、引号和注释 | 逐行修改，保留相邻内容 |
| INI / CFG / CONF | 仅限 INI 语法（节与键）；nginx、httpd、redis 这类指令式 `.conf` / `.cfg` 会被标记为不支持且不可编辑 | 逐行修改 |
| Java Properties | 支持转义键 | 逐行修改 |
| YAML | 完整解析 | 保存前提示可能重新排版或丢失注释 |
| TOML | 完整解析 | 保存前提示可能重新排版或丢失注释 |

JavaScript / TypeScript 配置文件不会被伪装成 JSON 打开。范例文件、锁文件、Schema 文件和构建目录也不会出现在可编辑列表里。

## 推断顺序

每一层都可以为同一个字段贡献不同属性，合并单位是字段属性，而不是整条字段：

1. JSON Schema
2. 内置常见配置模板
3. `*.example` / `*.sample` / `*.template` / `*.dist`
4. 本地 README；本地缺失时可回退到 GitHub README
5. 用户配置的 OpenAI 兼容 AI 服务
6. 当前值的结构推断

例如，Schema 可以提供整数范围，README 提供中文说明，示例文件提供默认值，而当前文件始终提供实际值。默认值不会自动写入；字段为空时可以手动点击“使用默认值”。

当某个字段仍然看不懂时，可以在字段旁手动点击“AI 解读”，让已配置的供应商解释用途、填写方式和注意事项。这个操作不会自动修改配置；发送前仍会屏蔽敏感值。

## 保存安全

- Renderer 只能通过 `contextBridge` 调用白名单 IPC；没有 HTTP 后端。
- 路径会限制在用户选择的项目目录中。
- 保存前展示逐字段差异。
- 保存时校验文件 hash，拒绝覆盖外部修改。
- 写入前生成 `.bak`，再通过同目录临时文件原子替换。
- 表单支持按字段名、路径和说明搜索；异常大的配置最多展示 2,000 个优先级最高的字段，避免桌面界面卡死。
- 扫描采用流式目录读取，并限制单次扫描最多处理 50,000 个目录项、4,000 个配置文件；超过上限会明确提示，可缩小项目范围后再试。
- API Key 与 GitHub Token 使用 Electron `safeStorage` 加密；系统安全存储不可用时保留原密文、不会被空值覆盖，并在设置页明确标注"已保存但无法解密"。
- 发给 AI 的配置会先按字段名屏蔽 Token、密码、密钥等敏感值。

## 开发

要求 Node.js 20.19+，在 Windows PowerShell 中运行：

```powershell
npm ci
npm run dev
```

完整检查：

```powershell
npm run check
```

生成便携桌面应用：

```powershell
npm run package
```

输出位于 `release/Confui-win32-x64/Confui.exe`。发布时请把整个 `Confui-win32-x64` 目录压缩成 ZIP，不要只上传 EXE；需要保留同目录的 DLL、`locales` 与 `resources`，它不是单文件程序。当前发布目标是 Windows x64，设置页的更新检查会打开 Release 下载页，下载后仍需手动替换旧目录。

## 目录

```text
core/       扫描、格式、推断、AI、设置与安全保存
electron/   主进程和安全 Preload 桥
shared/     IPC 与 Form Schema 契约
web/        Preact 桌面界面
 tests/      单元与集成测试项目
scripts/    确定性便携打包脚本
```

## 网络行为

Confui 只在下面三种情况下联网，其余功能完全本地：

| 场景 | 目标 | 触发条件 |
| --- | --- | --- |
| 补充文档 | GitHub README API | 本地 README 缺失，且项目填写了 GitHub 链接 |
| 拉取远程 JSON Schema | 仅 `json.schemastore.org`、`schemastore.org`、`raw.githubusercontent.com`、`unpkg.com`、`cdn.jsdelivr.net` | 配置文件声明了指向以上域名的 `https` `$schema` |
| 检查更新 | GitHub Release API | 在设置页手动点击检查 |

远程 `$schema` 只接受 `https` 与上述域名，其他地址会被跳过并在界面给出提示；拉取结果在内存中缓存 10 分钟。AI 请求只发往用户自己配置的 Base URL（必须是 `http` 或 `https`，且不允许把用户名或密码写进 URL）。

## 已知边界

- GitHub 链接只用于本地 README 缺失时补充文档；编辑仍需要本地项目文件夹。
- YAML / TOML 的语义会保留，但第三方解析器无法承诺完整保留注释和原排版，因此保存前会明确提示。
- YAML 的共享锚点可以读取；如果配置通过锚点形成循环引用，会为避免表单崩溃而拒绝打开。
- AI 是可选的最后回退层；未配置供应商时，其余推断能力仍可正常工作。
- 打包产物没有代码签名，首次运行时 Windows SmartScreen 可能提示"未知发布者"。
- 界面文案目前只有中文，尚未抽出 i18n 层。

## 许可证

[MIT](LICENSE)
