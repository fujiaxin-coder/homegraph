# 0031 — 运行时打包瘦身（dist 卫生 + optional openai）

| 字段 | 内容 |
| --- | --- |
| 编号 | 0031 |
| 类型 | 需求 / 设计 |
| 状态 | 已完成 |
| 日期 | 2026-09-14 |
| 范围 | HomeGraph `dist/` 资产、`copy-assets`、生产 `optionalDependencies`；相关测试与文档 |
| 关联 | 宿主继续消费同一份 npm / `dist` 产物，**不引入第二套打包形态**；仓外 `vendor-homegraph.ts` 不在本 Spec 修改；[0001](./0001-remove-unused-dirs-and-files.md) 只管源码死文件，不管安装体积 |

---

## 1. 背景与目标

`npm install --omit=dev` 后的生产树（以 `homegraph@1.5.7` darwin-arm64 vendor 实扫为基线）约 **173.5 MiB**。其中本 Spec **会动**的部分：

| 桶 | 体积 | 本 Spec |
| --- | --- | --- |
| `dist/extraction/wasm` | 44.6 MiB | `copy-assets` 盲拷全部 `*.wasm`（含已删的未引用 arkts）；改为清单拷贝 |
| HomeGraph `dist` 非 wasm | 8.6 MiB | JS 4.6 + sourcemap/d.ts map 4.0；发布去掉 map |
| `openai` + `@types/node` | ~8.3 MiB | 仅 `spec/llm`；改为 optional |

**明确不动（基线仅作对照）：**

| 桶 | 体积 | 说明 |
| --- | --- | --- |
| `tree-sitter-wasms` | 49.4 MiB | **保持** `dependencies`；运行时仍 `require.resolve('tree-sitter-wasms/out/…')` |
| `ohos-typescript` | 37.7 MiB | 后续另开 spec |
| `better-sqlite3` | 9.9 MiB | 已是 `optionalDependencies` |

`.ets` 走 ArkAnalyzer，不走 tree-sitter。语言实现与 grammar 加载分流保持现状。

**目标（单一发布形态）：**

1. **`copy-assets` 按清单拷贝**：只把 `VENDORED_WASM_LANGS` 对应的 `src/extraction/wasm/*.wasm` 打进 `dist`；禁止盲拷；禁止再打未引用的 `tree-sitter-arkts.wasm`。
2. **生产 dist 不含调试映射**：发布包去掉 `*.js.map` / `*.d.ts.map`；保留 `*.d.ts`（`package.json#types`）。
3. **`openai` 改为可选依赖**：MCP 主路径不强制安装；`spec` LLM 子命令在缺失时给出明确错误。

成功标准：相对 1.5.7，发布 dist 去掉 map 与未登记 wasm；未装 openai 时 MCP 仍可启动。`npm test` 语言覆盖与现网一致。

---

## 2. 范围

### 2.1 做（本仓）

- `copy-assets` 改为**清单拷贝**（附录 A），不再 `readdirSync` 盲拷所有 `*.wasm`。可抽成 `scripts/copy-assets.mjs`（或同等）；`npm run build` 仍走同一条路径。
- 发布构建关闭 `sourceMap` / `declarationMap`（或 copy 步骤删除 map 文件）。`declaration` 保持 true。
- `openai` → `optionalDependencies`；`spec/llm` 在 `require` 失败时抛用户可读错误，不得在 `bin/homegraph.ts` 顶层静态依赖 openai。
- 更新 `AGENTS.md`、`package.json` scripts、`CHANGELOG [Unreleased]`。

### 2.2 不做

- **不**把 `tree-sitter-wasms` 从 `dependencies` 挪走，**不**在构建时把它的 `out/*.wasm` 拷进 `dist`，**不**改 `resolveWasmPath`（vendored → `dist/extraction/wasm`，其余仍 `tree-sitter-wasms`）。
- **不**引入打包剖面、`HOMEGRAPH_GRAMMAR_PROFILE`、`pack:product`，或「产品嵌入专用树」。
- **不**按宿主裁剪语言集合；不删除 `src/extraction/languages/*` 或框架 resolver。
- 不把 `better-sqlite3` 从 `optionalDependencies` 拿掉。
- 不在本批修改 arkanalyzer / 阉割 `ohos-typescript` 内部文件（tsserver/tsc）。
- 不引入第二 npm 包名、不改 MCP 工具协议、不改索引 schema。
- 不把未 vendored 的 grammar 检入 `src/extraction/wasm/`。
- 不改仓外 `vendor-homegraph.ts`。

---

## 3. 行为与约束

### 3.1 Grammar 加载（不变）

| 项 | 约束 |
| --- | --- |
| vendored | `VENDORED_WASM_LANGS` → `path.join(__dirname, 'wasm', WASM_GRAMMAR_FILES[lang])` |
| 其余 | `require.resolve(\`tree-sitter-wasms/out/${WASM_GRAMMAR_FILES[lang]}\`)` |
| 盲拷禁止 | `src/extraction/wasm/` 里多出来的 `*.wasm` **不得**进入 dist |
| ArkTS | 仍 Exclude + ArkAnalyzer；**禁止**再打 `tree-sitter-arkts.wasm` |
| 缺文件 | 现有 warn + `unavailableGrammarErrors`；行为不变 |

### 3.2 依赖

| 包 | 变更后 | 理由 |
| --- | --- | --- |
| `tree-sitter-wasms` | **仍** `dependencies` | 本 Spec 不动 |
| `web-tree-sitter` | 仍 `dependencies` | 运行时 Parser |
| `arkanalyzer` | 仍 `dependencies` | ArkTS |
| `node-sqlite3-wasm` | 仍 `dependencies` | wasm SQLite 回退 |
| `better-sqlite3` | 仍 `optionalDependencies` | 本 Spec 不动 |
| `openai` | **改为** `optionalDependencies` | 仅 spec LLM |

`npm install --omit=dev --omit=optional` 将不再拉 `openai` 与 `better-sqlite3`；**仍会**安装 `tree-sitter-wasms`。

### 3.3 兼容

- 库用户 / CLI / MCP：语言能力与 1.5.7 对齐（arkts wasm 除外，本就未加载）。
- `homegraph spec` 在未安装 openai 时失败信息须含安装提示（例如 `npm i openai`），不得 uncaught `MODULE_NOT_FOUND` 直出。

---

## 4. 执行批次

实现必须按批合入；前一批验收通过再开下一批。偏离本表须先改 Spec。

### 批 A — dist 卫生

1. 抽出 `copy-assets`：只拷贝 `schema.sql` + 附录 A 清单内 wasm。
2. 发布包去掉 map；开发 `tsc --watch` 可继续生成 map（由 copy 删除，或发布用 tsconfig 覆盖）。
3. 单测：附录 A 文件均在 dist；未登记文件不在 dist。

预估：map ~4.0 MiB；挡住未引用 wasm。

### 批 B — `openai` 可选

1. `openai` 改 `optionalDependencies`。
2. `spec/llm` 缺失依赖时错误可读；补测试。
3. CHANGELOG `[Unreleased]`：默认安装可不含 openai；需要 spec LLM 时再装。

### 批 C — 后续（本 Spec 不验收）

- 剥 `ohos-typescript` 的 tsserver/tsc/locales（~28 MiB）：须真实 ArkAnalyzer 烟测，另开 spec。
- 是否裁剪 / 替换 `tree-sitter-wasms` 整包：另开 spec，**不在 0031**。

---

## 5. 验收标准

### 批 A

- [x] `copy-assets` 只按附录 A 拷贝 wasm；向 `src/extraction/wasm/` 丢一个未登记文件再 build，dist 中不得出现它。
- [x] 发布用 dist 不含 `*.js.map` / `*.d.ts.map`；`dist/index.d.ts` 仍存在。
- [x] `npm run build` + grammar 拷贝相关测试通过；typescript 仍从 `tree-sitter-wasms` 加载，lua 仍从 vendored dist 加载。

### 批 B

- [x] 未装 `openai` 时 `serve mcp` 可启动；触发 spec LLM 时错误可读。
- [x] CHANGELOG `[Unreleased]` 已说明 optional openai。

### 共同

- [x] 生产 `dependencies` **仍含** `tree-sitter-wasms`；`resolveWasmPath` 仍区分 vendored / wasms。
- [x] 未引入 MCP 工具/schema 变更，未引入第二套打包产物。
- [x] 实现类 commit footer：`Spec: docs/specs/0031-slim-runtime-pack.md`。

---

## 6. 风险与回滚

| 风险 | 缓解 |
| --- | --- |
| optional openai 被当成缺失生产依赖 | 文档写明；MCP 主路径不依赖它 |
| 清单漏拷某个 vendored wasm | 附录 A 与 `VENDORED_WASM_LANGS` 同源；测试断言文件集合 |

回滚：恢复盲拷 copy-assets 与 openai `dependencies`。

---

## 7. 非目标（重申）

- 不迁移 `tree-sitter-wasms` 到 dist / devDependencies。
- 不在本批裁剪 ohos-typescript / arkanalyzer。
- 不把宿主打包脚本当作本仓实现面。
- 不以「懒加载」代替「不打包」vendored 目录里的死文件。

---

## 附录 A — 须打进 dist 的 vendored wasm

仅 `VENDORED_WASM_LANGS` ∩ `WASM_GRAMMAR_FILES`。来源：`src/extraction/wasm/`。

| 文件 | 约计 |
| --- | --- |
| `tree-sitter-c_sharp.wasm` | 5.10 MiB |
| `tree-sitter-cfml.wasm` | 2.58 |
| `tree-sitter-cfquery.wasm` | 2.30 |
| `tree-sitter-cfscript.wasm` | 2.06 |
| `tree-sitter-cobol.wasm` | 15.60 |
| `tree-sitter-erlang.wasm` | 0.40 |
| `tree-sitter-lua.wasm` | 0.05 |
| `tree-sitter-luau.wasm` | 0.09 |
| `tree-sitter-nix.wasm` | 0.08 |
| `tree-sitter-pascal.wasm` | 0.68 |
| `tree-sitter-r.wasm` | 0.46 |
| `tree-sitter-scala.wasm` | 4.73 |
| `tree-sitter-terraform.wasm` | 0.09 |
| `tree-sitter-vbnet.wasm` | 6.18 |

**禁止出现在 dist：** `tree-sitter-arkts.wasm`；任何仅存在于 `tree-sitter-wasms/out/` 的文件（那些继续由该 npm 包在运行时提供）。

体积以构建机实测为准，上表为 1.5.7 vendor 实扫。

## 附录 B — 体积预期（相对 1.5.7 生产树 173.5 MiB）

口径：`dist/` + `npm install --omit=dev`。

| 步骤 | 主要变化 | 粗算 |
| --- | --- | --- |
| 基线 | 1.5.7 | 173.5 |
| A | 去 map；去误打 wasm | ~−4 |
| B + `--omit=optional` | 无 openai（及 better-sqlite3，安装方选择） | openai 约 −8；better-sqlite3 约 −10 不在本 Spec 强制 |

`tree-sitter-wasms` 49.4 MiB **仍在**生产树。

## 附录 C — 实测（实现后填写）

| 项 | 数值 |
| --- | --- |
| dist/extraction/wasm | 40.39 MiB / 14 files（附录 A） |
| 发布 dist 是否含 map | 否（0 个 `*.js.map` / `*.d.ts.map`）；`dist/index.d.ts` 保留 |
| 与 173.5 MiB 基线差（omit=dev） | dist 侧约 −4 MiB（map）+ 挡住未引用 wasm；完整生产树差取决于安装方是否 `--omit=optional`（openai / better-sqlite3） |
