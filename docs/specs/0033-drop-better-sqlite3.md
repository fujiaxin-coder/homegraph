# 0033 — 去掉 better-sqlite3（node:sqlite → wasm）

| 字段 | 内容 |
| --- | --- |
| 编号 | 0033 |
| 类型 | 需求 / 设计 |
| 状态 | 已完成 |
| 日期 | 2026-09-14 |
| 范围 | SQLite 后端选择、`optionalDependencies`、WAL checkpoint worker、status/CLI/MCP 文案、相关测试与文档 |
| 关联 | 承接 [0031](./0031-slim-runtime-pack.md) 未动的 `better-sqlite3` 体积桶（~9.9 MiB）；产品宿主离线 vendor 不跑 `prebuild-install`，源码进包却永远用不上 |

---

## 1. 背景与目标

`better-sqlite3` 作为 `optionalDependencies` 时，npm 包内携带 SQLite C amalgamation（解压约 **10 MiB**）。正常联网安装会靠其 `prebuild-install` 拉 GitHub Release 的 `.node`；**产品二次打包 / 离线 vendor 不跑该 install 脚本**，交付物里只剩源码，运行时既不编译也不加载 —— 纯占体积。

HomeGraph 已有：

1. **`node:sqlite`**（Node ≥22.5 且构建含 FTS5）— 内置 WAL，零额外依赖
2. **`node-sqlite3-wasm`**（`dependencies`）— 跨平台兜底，包内为编好的 wasm，无 C 源码

`engines` 已是 `>=22`。中间档 `better-sqlite3` 对离线集成与体积目标不再划算。

**目标：**

1. **彻底移除** `better-sqlite3` 与 `@types/better-sqlite3`（含 lockfile）。
2. 后端选择改为两级：**`node:sqlite`（有 FTS5）→ `node-sqlite3-wasm`**。
3. 删除 `native` 后端类型、探测、`HOMEGRAPH_SQLITE_BACKEND=native`、checkpoint/maintenance worker 中的 `require('better-sqlite3')`，以及 status/banner 中的 rebuild 文案。
4. 更新测试与 AGENTS/README/CHANGELOG；相对默认安装树再省约 **~10 MiB**（不再拉该 optional 包）。

成功标准：未安装 better-sqlite3 时 `init`/`status`/`npm test`（本机 Node 22.5+）走 `node-sqlite`；强制或无 FTS5 时走 `wasm`；代码与 lock 中无 `better-sqlite3` 字样（历史 CHANGELOG / 已结案 Spec 除外）。

---

## 2. 范围

### 2.1 做

- `package.json`：从 `optionalDependencies` 删除 `better-sqlite3`；从 `devDependencies` 删除 `@types/better-sqlite3`；同步 `package-lock.json`。
- `src/db/sqlite-adapter.ts`：两级选择；`SqliteBackend = 'node-sqlite' | 'wasm'`；去掉 `isNativeSqliteAvailable`；重写 WASM banner / `WASM_FALLBACK_FIX_RECIPE`（只提示升到 Node 22.5+）。
- `src/db/index.ts`：export 与 WAL checkpoint / `runPragmasOffThread` worker 不再引用 better-sqlite3；仅 `node-sqlite` 走 WAL checkpoint worker。
- CLI `homegraph status`、MCP `homegraph_status`、`HomeGraph.getBackend` 文档：去掉 `native (better-sqlite3)`。
- 测试：`sqlite-backend.test.ts`、`native-sqlite-backend.test.ts`（改名为仅测 node:sqlite WAL，或保留文件名但断言改为 node-sqlite）、以及探测 `require('better-sqlite3')` 的 skip 辅助函数改为 node:sqlite / wasm。
- `AGENTS.md`、`README.md`、`CHANGELOG [Unreleased]`。

### 2.2 不做

- 不引入自带多平台 `.node` 或 `@homegraph/sqlite-*` 分包。
- 不改 `engines`（仍 `>=22`）；不恢复 Node 18。
- 不改索引 schema / MCP 工具协议。
- 不重写历史 Spec（0003 / 0031）正文；本 Spec 覆盖现行行为。
- 不改仓外 `vendor-homegraph.ts`（由宿主在 vendor 时自然不再带上该包）。

---

## 3. 行为与约束

### 3.1 后端选择

| 顺序 | 条件 | 结果 |
| --- | --- | --- |
| 1 | `node:sqlite` 可用且 FTS5 探测通过 | `node-sqlite`（WAL） |
| 2 | 否则 | `wasm`（`node-sqlite3-wasm`；无真正 WAL） |

`HOMEGRAPH_SQLITE_BACKEND`：仅认可 `node-sqlite` | `wasm`。未知值（含旧的 `native`）忽略，走默认顺序。

### 3.2 依赖

| 包 | 变更后 |
| --- | --- |
| `better-sqlite3` | **移除** |
| `@types/better-sqlite3` | **移除** |
| `node-sqlite3-wasm` | 仍 `dependencies` |
| `openai` | 仍 `optionalDependencies`（0031） |

### 3.3 兼容

- Node 22.5+（FTS5）：行为与现网优先路径一致（本来就选 `node-sqlite`）。
- Node 22.0–22.4 或无 FTS5 的构建：以前可能 `native`，现在 **仅 wasm**（更慢、锁更敏感）——文档写明。
- 已设置 `HOMEGRAPH_SQLITE_BACKEND=native` 的环境：不再强制失败；回退默认两级选择。

---

## 4. 验收标准

- [x] `package.json` / lock 无 `better-sqlite3` / `@types/better-sqlite3`。
- [x] `createDatabase` 默认顺序为 `node-sqlite` → `wasm`；无 `native` 分支。
- [x] Node 22.5+ FTS5：`DatabaseConnection.initialize` → `getBackend() === 'node-sqlite'`。
- [x] `HOMEGRAPH_SQLITE_BACKEND=wasm` 可选中 wasm；`=native` 不选 native。
- [x] WASM banner / status 文案不再提 `npm rebuild better-sqlite3`。
- [x] `test/sqlite-backend.test.ts` 与 WAL 相关测试通过。
- [x] `CHANGELOG [Unreleased]` 说明移除与两级回退；实现 commit footer：`Spec: docs/specs/0033-drop-better-sqlite3.md`（待用户要求再 commit）。

---

## 5. 风险与回滚

| 风险 | 缓解 |
| --- | --- |
| 无 FTS5 / 旧 22.x 上性能回退到 wasm | README 推荐 22.5+；banner 提示升级 |
| 宿主曾依赖 `native` 环境变量 | 忽略并走默认；CHANGELOG 注明 |

回滚：恢复 optional `better-sqlite3` 与三级选择（git revert 本 Spec 实现）。

---

## 6. 非目标

- 不为 DevEco 预编译 better-sqlite3。
- 不把 SQLite 再做成第三个可选 npm 包。
