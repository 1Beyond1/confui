# AGENTS.md — Confui

本文件为 AI 编码助手与贡献者提供 Confui 项目的目录索引、架构红线、安全边界与常用命令。

## 目录地图

```text
shared/
  schema.ts               主进程与渲染进程共享的 IPC / FormSchema / Settings 类型契约
  validation.ts           全仓唯一校验真源（十六进制颜色、原型污染危险键、GitHub 仓库 URL）
core/
  formats/                多格式解析与写回引擎（按格式拆分：json/yaml/toml/env/ini/properties）
  formats.ts              兼容 re-export 入口（指向 core/formats/index.ts）
  inference/              6 层推断引擎（json-schema > known-template > example > readme > ai > heuristic）
  ai/                     OpenAI 兼容 AI 客户端与连接测试
  scanner.ts              流式项目扫描、未配对示例模板发现与多环境分组
  search.ts               受控并发的全项目跨文件脱敏配置搜索
  save.ts                 预览、版本校验、.bak 原子写回与恢复、模板初始化、配置对比补齐与脱敏导出
  paths.ts                项目目录防逃逸路径解析与安全路径读写
  files.ts                受限 UTF-8 读取、文件大小上限与哈希版本计算
  settings.ts             设置规范化、Windows 写入重试、Electron safeStorage 凭据加解密与渲染进程脱敏
  update.ts               GitHub Release 更新检查
  errors.ts               统一 ConfuiError 与 AppError 转换
electron/
  main.ts                 Electron 主进程、窗口生命周期、CSP、文件监听与 IPC 白名单路由
  preload.ts              沙盒化 contextBridge（window.confui）
web/src/
  App.tsx                 主应用壳层与流程编排
  components/             拆分后的页面与弹窗组件（HomePage / Sidebar / RawViewer / SaveConfirmModal 等）
  FieldEditor.tsx         表单分组、字段控件、校验与 AI 解读展示
  SettingsPage.tsx        AI / GitHub / 外观 / 语言 / 更新设置页
  editor-state.ts         表单值初始化、差异收集与前端校验
  utils/                  格式化与主题工具
  ui.tsx / icons.tsx      基础 UI 组件与 SVG 图标
tests/
  *.test.ts               Vitest 单元与集成测试
  fixtures/e2e-project/   多格式端到端测试夹具（测试不得修改夹具文件！）
scripts/
  package.mjs             确定性 Windows x64 便携目录打包脚本
```

## 架构红线

1. **无 HTTP 后端**：Renderer 只能通过 `electron/preload.ts` 暴露的 `window.confui` 白名单 IPC 与主进程通信，严禁引入本地 HTTP 服务。
2. **主进程是安全真源**：所有文件读写、路径防逃逸（含 symlink / junction 校验）、文件版本 hash 校验、预览二次生成、凭据解密均在主进程 / `core/` 完成，绝不信任 Renderer 传入的最终文本或路径。
3. **凭据不越界**：`apiKey` 与 `github.token` 使用 `safeStorage` 加密存储，主进程返回给 Renderer 的设置必须脱敏（仅返回 presence / hint），且发送给 AI 前必须递归脱敏敏感键与密钥特征。
4. **共享校验不重复**：十六进制颜色正则、危险键黑名单（`__proto__` / `prototype` / `constructor`）、GitHub URL 规范化统一维护在 `shared/validation.ts`。
5. **零高危生产依赖漏洞**：任何 `package.json` 依赖变更后必须确保 `npm audit --omit=dev --audit-level=high --registry=https://registry.npmjs.org` 返回 0 漏洞。

## 常用命令

```powershell
npm ci                                                              # 安装锁定依赖
npm run dev                                                         # 开发模式启动 Electron
npm run typecheck                                                   # TypeScript 类型检查
npm run test                                                        # 运行全部 Vitest 测试
npm run build                                                       # 构建 main / preload / renderer
npm run check                                                       # 完整验证（typecheck + test + build）
npm run package                                                     # 构建 Windows x64 便携包
npm audit --omit=dev --audit-level=high --registry=https://registry.npmjs.org
```

## 临时文件规范

- 所有调试、脚本或临时产物统一写入 `.tmp/`（已在 `.gitignore` 忽略），并在提交或交付前清空。
- 测试必须使用系统临时目录（`os.tmpdir()`），严禁在 `tests/fixtures/` 或仓库根目录残留 `.bak` / `.tmp` 文件。
