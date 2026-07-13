# easy_json 项目方案与任务书

## 一、项目概述

**easy_json** 是一个桌面软件，解决的核心痛点：随便捡一个开源项目，里面的 JSON 配置文件看不懂，还得翻 README 才知道每个字段干嘛用。

easy_json 自动扫描项目里的配置文件，通过多级推断搞清楚每个字段的含义，生成可编辑的表单界面，用户改完直接写回原文件。

---

## 二、技术栈

| 层 | 选型 | 理由 |
|---|---|---|
| 桌面框架 | Electron | 已有 Node.js + TS 后端，Electron 直接套壳，不用引入 Rust（Tauri） |
| 后端 \| Electron IPC（主进程直接暴露函数） \| 无 HTTP 层，contextBridge 桥接 |
| 前端 | Preact + Vite + TypeScript | 轻量，加载在 Electron BrowserWindow 里 |
| 共享类型 | shared/schema.ts | Form Schema 契约，前后端共用 |
| AI | OpenAI 兼容 API（用户自配供应商） | 支持 OpenAI / DeepSeek / OpenRouter / Ollama 等 |
| 设计工具 | Google Stitch MCP | 用 AI 生成 UI 设计 |

### 已完成的代码

项目已有可运行的基础骨架（`C:\Users\16873\Documents\easy_json`）：
- `shared/schema.ts` — Form Schema 契约（FieldSpec / ConfigFormSchema / AppSettings）
- `server/src/scanner.ts` — 配置文件扫描器（已知配置 + 锁文件过滤）
- `server/src/schema/infer.ts` — 三级推断引擎（JSON Schema / 已知模板 / 启发式+AI）
- `server/src/schema/known.ts` — 内置已知配置模板（tsconfig / package.json / eslintrc）
- `server/src/ai/provider.ts` — AI provider 抽象（OpenAICompatibleProvider，支持自定义 baseUrl）
- `server/src/ai/infer.ts` — AI 推断（读 JSON + README 生成 Form Schema）
- `server/src/config.ts` — 设置持久化
- `server/src/index.ts` — Fastify API（scan / infer / read / save / settings）
- `web/src/App.tsx` — 功能可用的占位 UI（扫描 / 表单 / 保存 / 设置面板）
- 冒烟测试通过：扫描 easy_json 自身 -> 推断 package.json（7 字段）/ tsconfig.json（11 字段）

### 需要改造的部分

1. 从"本地 Web 应用"改为"Electron 桌面应用"
2. 推断引擎从三级扩展为五级（加范例文件 + README 解析）
3. 前端从占位 UI 升级为正式设计（基于 Stitch 生成的设计语言）
4. 打包为 .exe

---

## 三、核心逻辑：五级推断流水线

用户给一个项目文件夹（或 GitHub 链接），软件扫描出所有 JSON 配置文件。对每个文件，按以下顺序逐级推断，**每一层都运行，结果按优先级 per-field merge**（高优先级覆盖低优先级，同一文件的不同字段可以来自不同层级）：

### ① JSON Schema 检测（最准）

- 检查 JSON 内是否有 `$schema` 字段
- 检查同级目录是否有 `schema.json`
- 如果找到，按 JSON Schema 规范解析出字段的 type / description / default / required / enum
- 局限：大部分项目不提供 JSON Schema

### ② 已知配置模板（覆盖常见项目）

- 内置字段库，目前已实现：`package.json`、`tsconfig.json`、`.eslintrc.json`
- 需要扩充：`vite.config`、`tailwind.config`、`next.config`、`webpack.config`、`.prettierrc` 等
- 每个模板手写字段的 label / description / type / default / enum / group
- 局限：只覆盖知名配置，冷门项目无效

### ③ 范例文件匹配【新建模块：examples.ts】

- 在项目目录中搜索范例文件：
  - `config.json.example`、`config.example.json`
  - `.env.example`、`.env.template`
  - `*.template`、`*.sample`、`*.dist`
- 从范例文件推断：
  - 字段存在性（范例里有的字段 = 用户应该配置的字段）
  - 默认值（范例里的值）
  - 注释（如果范例文件有 `# comment` 或 `// comment`，提取为字段描述）
  - 必填性（范例里没有值只有占位符如 `<YOUR_KEY>` 的 = 必填）
- 产出 Form Schema（source = "example"）

### ④ README / 文档解析【新建模块：readme.ts】

- **本地优先**：读取项目根目录 `README.md`、`README.rst`、`docs/` 目录
- **GitHub 补充**：如果本地没有 README，且用户提供了 GitHub 链接，通过 GitHub API（`GET /repos/{owner}/{repo}/readme`）拉取 README
- 从 README 中提取配置说明：
  - Markdown 表格（`| Field | Description | Default |`）
  - 代码块中的配置示例
  - 环境变量列表（`## Environment Variables` 章节下的 `KEY=value` 格式）
  - 配置章节（`## Configuration` 下的说明文字）
- 将提取的信息匹配到 JSON 字段，补充 description / default / required
- 产出 Form Schema（source = "readme"）

### ⑤ AI 分析（兜底）

- 前四级都没覆盖到的字段，交给 LLM
- 输入：JSON 原文 + 范例文件内容 + README 相关片段
- 输出：每个字段的 label / description / type / required / default / enum / secret
- 使用用户配置的 AI 供应商（OpenAI 兼容）
- 如果用户没配 AI，跳过此层，未覆盖字段显示为"未知"
- 产出 Form Schema（source = "ai"）

### 统一输出

每一层产出的都是同一份 Form Schema：

```typescript
interface ConfigFormSchema {
  file: string;           // 相对路径
  format: "json" | "yaml" | "toml" | "env" | "ini" | "properties";  // 文件格式
  kind: string;           // 文件类型
  fields: FieldSpec[];    // 字段列表
  source: FieldSource;    // "json-schema" | "known-template" | "example" | "readme" | "ai" | "heuristic"
  writable: boolean;
}

interface FieldSpec {
  path: string;           // 点号路径，如 "server.port"
  label: string;          // 人类可读标签
  description?: string;   // 字段说明
  type: FieldType;        // string | number | integer | boolean | enum | secret | color | object | array | json
  required?: boolean;
  default?: unknown;
  value?: unknown;        // 当前值
  enum?: Array<string | number>;
  secret?: boolean;       // 是否密码字段
  group?: string;         // 分组
  source?: FieldSource;   // 该字段的推断来源
}
```

---

## 四、输入方式

| 方式 | 说明 |
|---|---|
| 本地文件夹 | 用户选择项目目录，软件递归扫描 |
| GitHub 链接 | 用户填 repo URL，通过 GitHub API 拉 README + 文件结构（不 clone 整个仓库） |

两种方式可组合：选了本地文件夹后，如果检测到 `.git/config` 里的 remote URL，自动提示"要不要也读 GitHub 上的 README？"

README 读取优先级：本地 README > GitHub README > 跳过

---

## 五、UI 设计

### 设计方向

用户已确认偏好：有侧边栏、有卡片层次、有微妙阴影的"软件感"设计（非极简风）。参考 Stitch 生成的原版设置页设计。

三个页面：
1. **扫描页**：输入框（本地路径 / GitHub URL）+ Scan 按钮 -> 左侧文件列表 -> 右侧空状态
2. **表单页**：文件名标题 -> 分组表单字段（类型化控件）-> Save 按钮
3. **设置页**：AI 供应商配置表单（启用开关 / Provider Name / Base URL / Model / API Key）

### 字段控件类型

| FieldType | 控件 |
|---|---|
| string | 文本输入框 |
| number / integer | 数字输入框 |
| boolean | 开关 |
| enum | 下拉选择 |
| secret | 密码输入框（显示/隐藏） |
| color | 颜色选择器 |
| object | 嵌套表单（递归） |
| array | JSON 编辑区 |
| json | JSON 文本编辑区 |

---

## 六、任务清单

### Phase 1：Electron 桌面化

| # | 任务 | 说明 |
|---|---|---|
| 1.1 | 安装 Electron + electron-builder | `npm install -D electron electron-builder` |
| 1.2 | 创建 `electron/main.ts` | 主进程：创建 BrowserWindow，内嵌启动 Fastify，加载前端 |
| 1.3 | 创建 `electron/preload.ts` | IPC 桥接（文件选择对话框等原生能力） |
| 1.4 | 改造后端为 IPC 函数 | 去掉 Fastify HTTP，改为 Electron main 进程直接暴露函数（scan/infer/save/settings） |
| 1.5 | 改造 `web/vite.config.ts` + 定义 IPC 契约 | 构建目标改为 Electron renderer；定义 preload.ts 的 contextBridge API |
| 1.6 | 添加文件选择对话框 | 用 Electron dialog 让用户选文件夹（替代手动输入路径） |
| 1.7 | 打包配置 | electron-builder 配置 .exe 打包 |

### Phase 2：五级推断引擎

| # | 任务 | 说明 |
|---|---|---|
| 2.1 | 新建 `server/src/schema/examples.ts` | 范例文件发现 + 解析（.example / .template / .env.example） |
| 2.2 | 新建 `server/src/schema/readme.ts` | 本地 README 解析（提取表格 / 代码块 / 环境变量章节） |
| 2.3 | 新建 `server/src/schema/github.ts` | GitHub API 拉取 README（`GET /repos/{owner}/{repo}/readme`） |
| 2.4 | 改造 `server/src/schema/infer.ts` | 五级流水线串联：JSON Schema -> 已知模板 -> 范例文件 -> README -> AI |
| 2.5 | 扩充 `server/src/schema/known.ts` | 添加 vite.config / tailwind.config / next.config / .prettierrc 模板 |

| 2.7 | 添加 YAML/TOML 支持 | 安装 js-yaml + smol-toml；scanner 识别 .yaml/.yml/.toml；infer 内部统一转 JS 对象；save 转回原格式 |

### Phase 3：前端升级

| # | 任务 | 说明 |
|---|---|---|
| 3.1 | 统一设计系统 | 确定配色 / 字体 / 间距 / 圆角 / 阴影，写入 CSS 变量 |
| 3.2 | 重写扫描页 | 文件选择按钮 + GitHub URL 输入 + 文件列表侧栏 + 空状态 |
| 3.3 | 重写表单页 | 分组卡片 + 类型化控件 + 嵌套对象递归 + Save 按钮 + diff 预览 |
| 3.4 | 重写设置页 | AI 供应商表单 + 保存 + 连接测试按钮 |
| 3.5 | 添加推断来源标记 | 每个字段显示 source badge（JSON Schema / 模板 / 范例 / README / AI） |

### Phase 4：保存与安全

| # | 任务 | 说明 |
|---|---|---|
| 4.1 | JSON 格式保留 | 使用 jsonc-parser AST 级编辑，保留注释/缩进/键顺序 |
| 4.2 | 保存前 diff 预览 | 显示"将要修改哪些字段"，用户确认后写入 |
| 4.3 | 备份 + 安全存储 | 保存前备份 .bak；API Key 用 safeStorage 加密 | |

### Phase 5：打包与测试

| # | 任务 | 说明 |
|---|---|---|
| 5.1 | electron-builder 打包 | Windows .exe + 安装包 |
| 5.2 | 端到端测试 | 用真实开源项目测试完整流程（扫描 -> 推断 -> 编辑 -> 保存） |
| 5.3 | AI 推断测试 | 配置不同供应商（OpenAI / DeepSeek / Ollama）测试 AI 兜底 |

---


---

## 九、批判性反馈采纳记录

以下是根据外部 AI 评审反馈所做的修改（已采纳的）：

### 架构修改

1. **去掉 Fastify HTTP 层，改用 Electron IPC**
   - 原方案：Fastify 内嵌在 Electron 主进程，前端通过 HTTP 调后端
   - 新方案：主进程直接暴露 IPC 函数，前端通过 contextBridge 调用，无 HTTP 层
   - 理由：HTTP 层是过度设计，IPC 更简单、更安全、无端口冲突

2. **推断引擎改为 per-field 合并策略**
   - 原方案："上层有结果就不走下层"（per-file 互斥）
   - 新方案：每一层都运行，结果按优先级 merge（高覆盖低）。同一文件的不同字段可以来自不同层级
   - 合并规则：json-schema > known-template > example > readme > ai > heuristic（每层只补充上层未覆盖的字段）

3. **定义 IPC 通信契约**
   - preload.ts 暴露的 API：
     - `selectFolder()` -> 打开文件夹选择对话框
     - `scanProject(root)` -> 扫描配置文件
     - `inferSchema(root, file, options)` -> 推断 Form Schema
     - `saveConfig(root, file, value)` -> 保存配置
     - `getSettings()` / `setSettings(settings)` -> 读写设置
     - `watchFile(path, callback)` -> 文件变更监听
   - 全部异步（返回 Promise），主进程处理

4. **JSON 格式保留：使用 jsonc-parser**
   - VSCode 同款库，AST 级别修改，保留注释、缩进、键顺序
   - 保存时用 `modify()` 做增量修改，不是 `JSON.stringify` 全量重写

5. **API Key 加密存储**
   - 使用 Electron `safeStorage.encryptString()` / `decryptString()`
   - 不明文存储在磁盘上

### 功能补充

6. **范例文件匹配规则**
   - 同目录下搜索：`{filename}.example`、`{filename}.template`、`{filename}.sample`、`{filename}.dist`
   - 特殊文件：`.env.example` -> 匹配 `.env`
   - 多个范例文件时全部读取，合并字段信息

7. **README 解析置信度评分**
   - 表格匹配：高置信度（0.9）
   - 代码块匹配：中置信度（0.6）
   - 章节文字推断：低置信度（0.3）
   - 低置信度字段标注为 "suggested"，UI 上用虚线边框区分

8. **文件外部修改检测**
   - 使用 chokidar 监听已打开的配置文件
   - 外部修改时弹出提示："文件已被外部修改，是否重新加载？"
   - 保存时检测 mtime，如果外部已修改则提示冲突

9. **未保存修改标记**
   - 文件名旁显示红点表示有未保存的修改
   - 切换文件时提示保存

10. **加载/进度/错误状态**
    - 扫描时显示进度条
    - AI 推断时显示 loading spinner
    - 解析失败的文件在列表中标记错误图标
    - 文件列表支持搜索/过滤

11. **暗色模式**
    - CSS 变量切换，跟随系统或手动切换

12. **表单校验规则**
    - 从 JSON Schema 解析 minLength / maxLength / pattern / minimum / maximum
    - 前端实时校验，错误提示在字段下方

13. **secret 字段在 AI prompt 中 mask**
    - 发送给 LLM 的 JSON 内容中，secret 类型字段的值替换为 `"***"`
    - 避免泄露密码/Token

14. **大文件限制**
    - >1MB 的 JSON 文件标记警告，不进行 AI 推断（token 太多）
    - >5MB 的文件直接跳过

15. **嵌套 JSON 深度限制**
    - >3 层嵌套自动折叠为 JSON 编辑区
    - 避免缩进过深无法操作

16. **最近打开项目历史**
    - 保存最近 10 个项目路径
    - 启动时显示历史列表，一键打开

### 追加采纳（v0.1 即支持）

| # | 建议 | 说明 |
|---|---|---|
| 17 | **YAML / TOML 配置文件支持** | 扫描器识别 .yaml/.yml/.toml；解析为 JS 对象走同一套推断流水线；保存时转回原格式。用 js-yaml（YAML）和 smol-toml（TOML）。格式保留：YAML 用 dump + 原缩进选项，TOML 用 stringify。复杂度低，因为内部统一用 Form Schema，只是输入输出多两个编解码器 |



| 建议 | 理由 |
|---|---|
| Fastify worker 线程 | 改 IPC 后不存在阻塞 |
| 循环引用 JSON | JSON 规范不支持循环引用 |
| 代码签名 / 自动更新 | v2 功能，开发阶段不需要 |
| 匿名数据收集 | 过度设计 |
| 虚拟滚动 | 文件列表不会过千，不需要 |


## 七、已知风险与待确认

1. **GitHub API 限流**：未认证的 GitHub API 每小时 60 次请求。如果用户频繁用 GitHub 链接功能，可能需要让用户填 GitHub Token（放在设置页）。

2. **README 解析的准确率**：README 格式五花八门，从 Markdown 表格 / 代码块 / 章节文字中提取配置说明不是 100% 准确。这一层的产出需要标记为"推测性"，用户可手动修正。

3. **JSON 格式保留**：标准 `JSON.stringify` 会丢失原始格式（缩进、键顺序、注释）。如果要严格保留，需要用 AST 级别的 JSON 编辑库（如 `jsonc-parser`）。是否需要严格保留，还是"格式化输出（2 空格缩进）"就够了？

4. **Electron 包体积**：Electron 基础包 ~150MB。如果在意体积，可考虑 Tauri（~10MB），但需要 Rust 后端重写。当前选 Electron 优先开发效率。

5. **AI 供应商兼容性**：不同 OpenAI 兼容端点的 `response_format: { type: "json_object" }` 支持不一。部分供应商（如 Ollama）可能不支持 JSON mode，需要 fallback 到正则提取 JSON。

---

## 八、Stitch MCP 接入备忘

（已修复并验证，存于记忆中）

- 端点：`https://stitch.googleapis.com/mcp`
- 鉴权：`X-Goog-Api-Key` 头
- **必须加** `Accept: application/json` 头（否则 Codex HTTP 客户端会挂死在 SSE 上）
- `generate_screen_from_text` 的 `projectId` 用纯数字（不带 `projects/` 前缀）
- 工作流：`create_project` -> `create_design_system` -> `generate_screen_from_text` -> 下载 `htmlCode.downloadUrl`
