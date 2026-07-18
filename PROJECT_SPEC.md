# Confui 0.2 产品与验收规格

## 1. 产品目标

Confui 面向经常下载、试用开源项目但不想反复阅读配置文档的用户。用户选择本地项目后，应用应完成四件事：

1. 找到真正可编辑的配置文件。
2. 尽可能解释字段的用途、类型、约束、默认值和敏感性。
3. 用合适的桌面控件编辑，并在输入阶段阻止明显错误。
4. 在不静默覆盖外部修改、不泄露凭据的前提下写回文件。

Confui 不是代码配置执行器，不解析或改写 `vite.config.ts`、`next.config.js` 等可执行源码；也不是远程仓库编辑器。

## 2. 当前范围

### 输入

- 本地项目文件夹：必选，是扫描和编辑的数据源。
- GitHub 仓库链接：可选，仅在本地 README 缺失时作为文档回退。
- 本地 `.git/config` 中的 GitHub remote：可自动识别。

### 配置格式

- JSON / JSONC（支持注释与尾随逗号）
- YAML / YML
- TOML
- ENV
- INI / CFG / CONF
- Java Properties

### 不扫描

- 锁文件、Schema、示例文件、备份文件
- `node_modules`、`.git`、构建产物、缓存、虚拟环境
- JavaScript / TypeScript 配置源码
- 超过 5 MB 的文件只显示警告，不打开

## 3. 架构

```text
Preact renderer
      |
contextBridge typed IPC
      |
Electron main process
      |
core modules (filesystem / inference / save / settings / AI)
```

- 无 Fastify、无本地端口、无 HTTP 后端。
- Renderer 开启 `contextIsolation` 和 `sandbox`，关闭 `nodeIntegration`。
- Preload 以 sandbox 兼容的 CommonJS 产物加载。
- 所有 IPC 返回统一的 `Result<T>`，错误包含稳定 code 与用户可读说明。

## 4. 字段推断

### 来源优先级

`json-schema > known-template > example > readme > ai > heuristic`

每一层都运行；合并发生在 `label`、`description`、`type`、`required`、`default`、`enum`、约束、分组等属性级别。当前值只来自实际配置文件，示例默认值不会自动成为未保存修改。

### JSON Schema

- 支持配置中的 `$schema`、同目录 `{name}.schema.json` 与 `schema.json`。
- 支持本地相对引用、远程 Schema、内部 `$ref` 与基础 `allOf` 合并。
- 提取类型、标题、描述、必填、枚举、默认值、数字范围、字符串长度与正则。

### 已知模板

- `package.json`
- `tsconfig.json` / `jsconfig.json`
- ESLint JSON 配置
- Prettier JSON 配置

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
- 发送前递归屏蔽敏感键值。

## 5. 桌面交互

### 开始页

- 文件夹路径与原生文件夹选择器。
- 可选 GitHub URL。
- 最近 10 个项目，一键重新扫描打开。

### 项目侧栏

- 始终显示项目、文件数、格式、大小和当前文件。
- 文件名搜索与格式筛选可组合。
- 大文件状态可见。
- 当前文件有未保存内容时显示状态点。

### 编辑器

- 按分组呈现字段；支持文本、数字、整数、枚举、开关、颜色、密码、数组和 JSON 控件。
- 显示字段路径、推断来源、必填和默认值。
- 数值范围、整数、字符串长度、正则、必填与 JSON 语法实时校验。
- 表单与只读原始内容可切换。
- `Ctrl+S` 保存，`Ctrl+O` 打开项目。

### 离开保护

- 切换文件、设置、项目、重新扫描、重新加载前拦截未保存配置。
- 设置页自身有独立未保存保护。
- 关闭应用窗口时使用原生确认框拦截未保存配置或设置。
- 外部文件修改显示持续横幅；保存时仍执行 hash 冲突检查。

### 设置

- AI 启用开关与 OpenAI、DeepSeek、OpenRouter、Ollama、自定义供应商入口。
- 连接测试。
- GitHub Token。
- 跟随系统 / 浅色 / 深色。
- 敏感字段显示切换；设置保存失败必须显示错误，不产生未处理异常。

## 6. 保存契约

1. Renderer 提交字段路径和值及打开时的 `FileVersion`。
2. 主进程重新读取文件并校验 hash / size。
3. 主进程生成精确预览；Renderer 不可伪造最终输出。
4. 用户确认后，主进程再次校验版本并重新生成输出。
5. 创建 `.bak`，写同目录临时文件，继承权限并原子替换。
6. 返回新版本，应用清除脏状态并抑制自己的监听事件。

JSONC、ENV、INI、Properties 使用增量或逐行策略。YAML / TOML 使用全量序列化，预览必须显示注释 / 排版风险。

## 7. 验收门槛

发布前必须同时满足：

- `npm run typecheck` 无错误。
- `npm run test` 全通过，覆盖格式保留、推断属性合并、歧义保护、密钥屏蔽、设置加密、冲突保存与编辑器状态。
- `npm run build` 生产构建成功。
- Electron 实际启动无 Preload、console 或 page error。
- 至少一个真实完整流程：扫描 -> 推断 -> 校验 -> 预览 -> 保存 -> 备份 -> 重新加载。
- 每个支持格式都完成解析 / 保存自动化测试；UI 至少打开并核对字段。
- 浅色、深色、启动尺寸和 1024×680 最小布局无横向溢出、关键控件裁切或文本重叠。
- 便携目录中的 `Confui.exe` 可独立启动，资源中不包含 `core/`、`web/`、`tests/` 等源码目录。
- Git worktree 无测试产生的 `.bak`、修改后 fixture 或 release 文件。

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
