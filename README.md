# Mini Notes with LLM Summary

一个本地运行的 **Anna App**：用户创建 / 查看 / 删除笔记，点击 Summarize 后由本地
**Executa Tool** 通过 reverse `sampling/createMessage` 借用 host LLM 生成总结。

完整核心链路严格遵循 Anna 平台模型：

```text
Anna App iframe
  → AnnaAppRuntime.connect()
  → anna.storage.get / anna.storage.set    （笔记持久化）
  → anna.tools.invoke(...)                 （调用本地 Executa Tool）
  → 本地 Executa Tool invoke
  → reverse JSON-RPC sampling/createMessage （借用 host LLM）
  → host LLM 或本地 mock sampling fixture
  → summary 返回 UI 展示
```

> 本仓库不需要真实 Anna 账号、不需要 `anna-app login`、不需要真实 LLM API key、
> 不需要云端数据库。所有验证都通过 `anna-app dev` 本地 harness 完成。

---

## 1. 项目结构

```text
.
├── manifest.json                  # Anna App manifest（schema / required_executas / ui / dev）
├── app.json                       # 应用列表元信息（`anna-app apps publish` 用）
├── package.json                   # 根脚本：build / validate / dev / executa / test / package
├── frontend/                      # 工程化前端（Vite + TypeScript）
│   ├── index.html
│   ├── vite.config.ts             # base:"./"，输出到 ../bundle
│   ├── tsconfig.json              # strict
│   └── src/
│       ├── main.ts                # 启动：连接 runtime、绑定存储/工具/UI
│       ├── anna.ts                # AnnaAppRuntime.connect() 封装（连接层）
│       ├── notesStore.ts          # 笔记存储 —— 只走 anna.storage.get/set（storage 层）
│       ├── summarize.ts           # 总结 —— 只走 anna.tools.invoke（tools 层）
│       ├── ui.ts                  # 纯 DOM 渲染 + 事件绑定（UI 层）
│       └── types.ts               # 领域类型
├── bundle/                        # `npm run build` 产物（manifest.ui.bundle.entry 指向这里）
├── executas/notes-summarizer/     # 本地 Executa Tool（Node，JSON-RPC 2.0 over stdio）
│   ├── server.js                  # initialize / describe / invoke / health / shutdown + sampling
│   ├── executa.json               # 本地 discovery（tool_id / type / command）
│   ├── package.json               # name / version / executa.tool_id
│   └── fixtures/
│       ├── sampling-mock.jsonl    # `--mock-sampling` 用的采样 fixture（后端 sampling 测试）
│       └── llm-mock.jsonl         # `--mock-llm` 用的完整链路 mock（可选，本地联调）
└── scripts/
    ├── test-protocol.js           # 手动协议测试：伪装 host 驱动 initialize/describe/invoke/sampling
    └── build-binary.sh            # 三平台二进制打包（识别本机架构 + 符合 binary distribution）
```

---

## 2. 安装依赖

要求 Node ≥ 18（推荐 20 / 22），并已安装 `anna-app` CLI（通过根 devDependency 提供）。

```bash
npm run install:all
# 等价于：
#   npm install                                  （根，含 @anna-ai/cli）
#   npm --prefix frontend install                 （Vite + TypeScript）
#   npm --prefix executas/notes-summarizer install （@yao-pkg/pkg，打包用）
```

`anna-app` CLI 会以 `npx anna-app ...` 方式调用（根 `node_modules/.bin` 已包含）。

---

## 3. 构建前端 bundle

```bash
npm run build          # = npm --prefix frontend run build（vite build）
```

产物输出到 `bundle/`，`manifest.json` 的 `ui.bundle.entry` 指向 `index.html`，
`ui.bundle.format` 为 `static-spa`，因此 `anna-app dev` 会直接加载该 bundle。

---

## 4. 校验 manifest

```bash
npm run validate       # = npx anna-app validate --strict
```

通过会输出 `✓ validate passed`。该校验会检查 `schema` / `required_executas` /
`permissions` / `ui.*` / `host_capabilities` 等字段的一致性。

---

## 5. 启动 UI harness（`anna-app dev --no-llm`）

```bash
npm run dev            # = npx anna-app dev --no-llm
```

启动后终端会打印本地 dashboard 地址（默认 `http://localhost:5180/`），并在其中
自动打开 Mini Notes App iframe。

UI harness 验证点：

- **创建笔记**：输入文字点「添加」→ 列表立即出现；空输入不会保存；保存后输入框清空。
- **查看笔记**：列表展示内容 + 添加顺序（`#order`），可选时间戳 / 空状态。
- **删除笔记**：点「✕」→ 列表立即更新。
- **点击 Summarize**：见下一条。

### 如何确认笔记读写走的是 `anna.storage.*`

- 源码证据：`frontend/src/notesStore.ts` 的 `list()` / `add()` / `remove()` **只**调用
  `anna.storage.get({ key: "mini-notes:notes" })` 与 `anna.storage.set({...})`，
  没有任何 `localStorage` / `IndexedDB` / `fetch` / 文件系统代码。
- 运行时证据：打开浏览器 DevTools，在 iframe 中可以看到 App 向 host 发送的
  `postMessage` RPC 帧，`ns` 为 `storage`、`method` 为 `get` / `set`。
- 脚本证据：`scripts/test-protocol.js`（后端）配合 UI 行为共同证明存储链路。

### 为什么 `--no-llm` 下点击 Summarize 会得到 `[-32603] harness started with --no-llm`

`--no-llm` 会禁用 harness 的 LLM bridge。点击 Summarize 时：

1. 前端**仍然**正常调用 `anna.tools.invoke({ tool_id: "tool-dev-mini-notes-summarizer", method: "summarize", ... })`；
2. 本地 Executa Tool 正常执行 `invoke`，并**确实发起**了 reverse `sampling/createMessage`；
3. harness 收到 sampling 后因 LLM 被禁用而返回错误 `[-32603] harness started with --no-llm`；
4. Tool 将该错误原样回传，前端把错误展示为 `Summarize 失败：[-32603] harness started with --no-llm`。

**这是 App 调试路径的预期结果**，说明 `anna.tools.invoke → 本地 Tool → sampling` 的
wiring 是通的；它**不代表**后端 Tool 的 sampling 失败。真正的 sampling 验证见第 6、7 节。

---

## 6. 单独测试后端 Executa sampling（`--mock-sampling`）

```bash
npm run executa:invoke
# = anna-app executa dev --dir executas/notes-summarizer \
#     --invoke summarize \
#     --args '{"notes":[{"order":1,"text":"明天跟客户 follow up"},{"order":2,"text":"修复登录 bug"}]}' \
#     --mock-sampling executas/notes-summarizer/fixtures/sampling-mock.jsonl
```

该命令用 `fixtures/sampling-mock.jsonl` 模拟 host 对 `sampling/createMessage` 的响应，
返回的 summary 文本来自 fixture（例如 `(mock-sampling) ...`），证明 summary 由 sampling
返回，而非 Tool 本地规则拼装。

### 如何确认 `sampling/createMessage` 被 Tool 发起

- 用 `scripts/test-protocol.js`（见第 7 节）：伪装 host 会在收到 Tool 发起的
  `sampling/createMessage` 时打印 `← tool issued sampling/createMessage (id=...)`，
  并校验 `metadata.executa_invoke_id` 与父 `invoke_id` 一致。
- `server.js` 在 stderr 打印 `summarize: issuing sampling/createMessage for N note(s) ...`
  作为日志证据。

---

## 7. 手动测试 Executa JSON-RPC（initialize / describe / invoke）

内置脚本 `scripts/test-protocol.js` 伪装成一个 Anna host，对 Executa Tool 做完整对话：

```bash
npm run test:protocol
```

它依次验证：

1. `initialize` → `protocolVersion == "2.0"` 且 `client_capabilities.sampling` 已声明；
2. `describe` → 返回裸 manifest（`name`、`host_capabilities: ["llm.sample"]`、`tools[]` 的
   `parameters[]` 形态、`runtime`）；
3. `invoke(summarize)` → 返回 `success: true`，且 `data.summary` 等于 fake host 的采样文本；
4. **sampling 证据** → Tool 恰好发起一次 `sampling/createMessage`，且 `metadata.executa_invoke_id`
   与 `params.context.invoke_id` 都回显了父 `invoke_id`；
5. `health` / `shutdown` → 正常响应；
6. stdout 纪律 → 每一行都是合法 JSON-RPC 帧（无 banner / 日志混入）。

也可对打包后的二进制直接跑（见第 9 节）。

---

## 8. 如何确认 summary 走的是 `anna.tools.invoke → Executa → sampling/createMessage`

- 源码证据：
  - 前端 `frontend/src/summarize.ts` **只**调用 `anna.tools.invoke(...)`，从不调用
    `anna.llm.complete`、从不 `fetch`、从不本地拼装 summary；
  - Tool `executas/notes-summarizer/server.js` 的 `handleSummarize` **只**通过
    `sampling.createMessage(...)` 获取文本并原样返回；
- 运行时证据：`--no-llm` 下点击 Summarize 出现 `[-32603] harness started with --no-llm`
  （说明调用已穿透到 harness 的 sampling 门）；
- 脚本证据：`npm run test:protocol` 的第 3/4 步，以及 `npm run executa:invoke` 的 mock 采样输出。

---

## 9. 本机二进制打包

```bash
npm run package          # = bash scripts/build-binary.sh  （自动识别本机架构）
npm run package:test     # = 打包 + 对打包产物做 describe 冒烟 + 完整协议测试
```

`scripts/build-binary.sh`：

- 用 `@yao-pkg/pkg` 将 `server.js` 编译为单文件可执行体；
- 识别本机架构（`uname -s/-m`），也可用 `--platform darwin-arm64` 等强制指定；
- 按 Anna binary distribution 规范生成 archive：

```text
mini-notes-summarizer-<ver>-<platform>.tar.gz   (macOS / Linux)
mini-notes-summarizer-<ver>-<platform>.zip      (Windows)

archive 结构（manifest.json 位于 archive 根）：
  manifest.json     → runtime.binary.entrypoint + permissions
  bin/mini-notes-summarizer[.exe]
```

至少支持 `darwin-arm64` / `darwin-x86_64` / `windows-x86_64` 三个平台 key。

---

## 10. GitHub Actions 发布

Workflow 位于 `.github/workflows/release.yml`。

- **触发方式**：
  - push 一个 `v*` tag（推荐），或
  - 手动 `workflow_dispatch`（可传 tag，缺省从 Executa 包版本推导）。
- **产物**：一次发布会构建并上传以下 GitHub Release assets：
  - `*-darwin-arm64.tar.gz`
  - `*-darwin-x86_64.tar.gz`
  - `*-windows-x86_64.zip`
  - （额外）`*-linux-x86_64.tar.gz`，仅用于在 CI 里做可执行冒烟测试
- **冒烟测试**：对 Linux 二进制解包后，校验 archive root `manifest.json` 的
  `runtime.binary.entrypoint`，并对打包二进制跑完整 `initialize / describe / invoke / health`。

---

## 11. manifest / bundle / executas / storage / sampling / binary archive 的关系

- **`manifest.json`**：声明这个 Anna App 的元信息与能力——`required_executas`（依赖哪个
  Executa Tool）、`permissions`、`ui.bundle`（前端入口）、`ui.views`（窗口）、
  `ui.host_api.storage` / `ui.host_api.tools`（iframe 内可用哪些 Host API）、`dev` 配置。
- **`bundle/`**：`npm run build` 生成的前端静态 SPA，被 `manifest.json` 的 `ui.bundle.entry`
  引用，由 `anna-app dev` 加载进 iframe。
- **`executas/`**：本地 Executa Tool 源码。App iframe 通过 `anna.tools.invoke` 触发；
  Tool 与 host 通过 **JSON-RPC 2.0 over stdio** 通信，并声明 `host_capabilities: ["llm.sample"]`。
- **Anna storage / APS KV**：App 的持久化 Host API。本地无 login 时由 harness 用
  `legacy in-memory runtime_state` 支撑 `anna.storage.get/set`；生产环境对应
  Anna Persistent Storage（APS）KV。
- **sampling**：Executa Tool 向 host 发起的 reverse JSON-RPC `sampling/createMessage`，
  用于借用 host LLM（本地用 `--mock-sampling` fixture 模拟）。
- **binary archive**：把 Executa Tool 打包成平台独立可执行体 + archive root `manifest.json`
  的发布产物，供真实 Anna 平台分发（不在本地 harness 里加载）。

---

## 快速验证清单（对应验收标准）

```bash
npm run install:all
npm run build
npm run validate                          # ✓ validate passed
npm run dev                               # UI harness：建/删笔记，点 Summarize 见 [-32603] no-llm
npm run executa:invoke                    # 后端 sampling 走 --mock-sampling，返回 fixture 文本
npm run test:protocol                     # 手动协议测试：initialize/describe/invoke + sampling 证据
npm run package:test                      # 本机二进制打包 + archive 结构 + 冒烟
```
