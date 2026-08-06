# 0003 — 支持 Node.js 18 及以上（含解除 Node 25+ 硬阻断）

| 字段 | 内容 |
| --- | --- |
| 编号 | 0003 |
| 类型 | 变更 |
| 状态 | 已完成 |
| 日期 | 2026-08-06 |
| 范围 | Node 运行时版本上下限门禁、WASM Zone OOM 缓解在 Node 25+ 上的有效性、依赖兼容、`scripts/test-node-matrix.sh`（18–25）、文档/测试对齐 |

---

## 1. 背景与目标

当前产品声明与运行时门禁均为 **Node `>=20 <25`**：

- 下限 20：历史上因 Node 18 EOL 抬高（CHANGELOG / #81 叙事）；
- 上限 `<25`：Node 25.x 上 V8 turboshaft WASM JIT 在编译 tree-sitter grammar 时会 `Fatal process out of memory: Zone`，产品侧硬退出（`buildNode25BlockBanner`）。Node 22/24 已用 `--liftoff-only` 重启缓解（#293 / #298）；CHANGELOG 称 **同一 flag 当时未能覆盖 Node 25 变体**，故继续阻断。

本需求要求两端都打通：

1. **下限**：重新支持 **Node 18+**；
2. **上限**：解决 **major ≥ 25**——取消硬阻断，并在真实索引路径上验证不再因 Zone OOM 崩溃（不能「只删 exit、不管 crash」）。

**目标：**

1. 对外声明：**支持 Node.js `>=18.0.0`**（不再写死 `<25`）；推荐仍写 **22 LTS / 22.5+**（`node:sqlite`）；
2. CLI / MCP 在 Node **18.x** 与 **25.x（及实现时已发布的更新 major，如 26）** 上均可启动，不因版本横幅硬退出；
3. 在 Node 25+ 上，带 grammar 编译的核心路径（至少 `index` / 测试里加载 wasm grammar）**不以** `Fatal process out of memory: Zone` 失败；
4. 文档、`engines`、门禁、测试一致。

---

## 2. 范围

### 2.1 纳入

**版本门禁与声明**

- `package.json` / lockfile 的 `engines.node`；
- `src/bin/node-version-check.ts`、`src/bin/homegraph.ts`：下限改为 18；**删除或退役** Node 25+ 硬阻断路径；
- 相关单测（含 `test/node-version-check.test.ts`）与文档：`README.md`、`AGENTS.md`、`DEVELOPMENT.md`、release workflow 注释、`CHANGELOG` `[Unreleased]`。

**Node 18 兼容**

- 显式 `engines ≥20` 的直接依赖（见 §4.1）；
- Node 18 上 SQLite 落点与提示（见 §3.2）。

**Node 25+ 可运行性（本需求硬要求）**

- `src/extraction/wasm-runtime-flags.ts` 及所有保证 `--liftoff-only`（或替代 flag）送达主进程 / parse worker / vitest forks / MCP daemon 的路径；
- 在 **Node 25+** 上复现或证伪「liftoff 无效」；若无效，换用有效缓解后再解除阻断（见 §3.4、§6）；
- Node 25+ 上的 `build` + 约定测试 + 至少一次真实 `index`（多 grammar 或本仓库）冒烟。

**多 Node 兼容性脚本（本需求硬要求）**

- `scripts/test-node-matrix.sh` + `package.json` 的 `test:node-matrix`；
- 默认矩阵覆盖 major **`18 19 20 21 22 23 24 25`**（见 §5.1）。

### 2.2 不纳入

- 不要求 Node 18 获得与 ≥22.5 同等的 `node:sqlite` 性能；
- 不把 `telemetry-worker/` 等子包 engines 强行对齐（除非阻塞本包安装）；
- 不借机重写 CLI / MCP / 索引算法；
- 不承诺 **Node &lt;18**；
- 不承诺跟踪每一个未来 Node major 的 V8 回归——但 **解除阻断的前提是：当前目标 major（实现时的 latest current，至少 25）已验证通过**；若日后新 major 再炸，允许另开 hotfix 再阻断或换 flag（须更新本 Spec 或新 Spec）。

---

## 3. 行为与约束

### 3.1 版本门禁（硬约束）

| 条件 | 行为 |
| --- | --- |
| `major < 18` | 打印过旧横幅并 `exit(1)`；`HOMEGRAPH_ALLOW_UNSAFE_NODE=1` 可覆盖（保留） |
| `major ≥ 18` | **允许启动**（含 18…24、**25、26…**） |
| ~~`major ≥ 25` 硬退出~~ | **删除**。不得再默认 `exit(1)` |

- `MIN_NODE_MAJOR = 18`，与 `engines` 下限一致。
- `engines` 目标：`"node": ">=18.0.0"`（**无上限**）。若 npm/工具链对无上限有顾虑，可用 `"≥18.0.0"` 等价写法；**禁止**再写 `<25`。
- `buildNode25BlockBanner`：实现时二选一并写清——**(A) 删除**导出与测试；或 **(B) 保留为仅文档/telemetry 用的弃用警告且默认不 exit**。推荐 **A**，避免「半阻断」误导。
- `HOMEGRAPH_ALLOW_UNSAFE_NODE`：25+ 阻断去掉后，该 env 仅服务于「&lt;18 强制跑」；文案须改到不再暗示「用来强开 Node 25」。

### 3.2 SQLite 后端期望

三级回退不变：`node:sqlite`（≥22.5 **且该构建含 FTS5**）→ `better-sqlite3` → `node-sqlite3-wasm`。

选用 `node:sqlite` 前须探测 FTS5（`:memory:` 上 `CREATE VIRTUAL TABLE … USING fts5`）；缺失则记失败并回退。部分官方 Node 构建（已复现：**Node 23.x**）暴露 `DatabaseSync` 但未编入 FTS5，直接用会在 schema init 报 `no such module: fts5`。

| Node 区间 | 期望默认路径 |
| --- | --- |
| ≥22.5（含 FTS5） | 优先 `node:sqlite` |
| ≥22.5 但无 FTS5（如 23.x） | `better-sqlite3` 或 wasm（跳过残缺 `node:sqlite`） |
| 20–22.4 | `better-sqlite3` 或 wasm |
| 18.x / 19.x | 无 `node:sqlite`；`better-sqlite3@11` 若不可用则 **wasm** 兜底 |
| ≥25 | 与 ≥22.5 相同优先级（须 FTS5 探测通过；`better-sqlite3@11` 可作回退） |

Node 18 不得因选不到 native 而启动失败；提示不得再逼用户「必须升到 20」，可建议「推荐 22.5+」。

### 3.3 功能可用性（各支持 major 最低条）

在干净安装下，**Node 18** 与 **Node 25+**（实现时至少验证一个 25.x；有条件再加 26）均应能：

1. `npm run build`（优先在该 Node 上直接 build + test）；
2. `homegraph init` + `homegraph index`（小 fixture 或本仓）；
3. `homegraph serve mcp` initialize 并列出工具；
4. 至少一条查询路径不因缺失 API 崩溃。

Node 22+ 可选 API（如 `enableCompileCache`）须 `?.` 守卫，在 18 上不抛错。

### 3.4 Node 25+ WASM Zone OOM —— 解除阻断的前置条件

**原则：先证明可安全运行，再删硬阻断。** 禁止只改 `engines` / 删 `exit` 而不做 Zone 验证。

**已知机制（现状代码）：**

- 崩溃症状：`Fatal process out of memory: Zone`（V8 内部 arena，非 JS heap）；
- 22/24 缓解：进程级 `--liftoff-only`（+ `--max-old-space-size`），经 `relaunchWithWasmRuntimeFlagsIfNeeded` 注入；vitest `poolOptions.forks.execArgv` 同样带上；
- 历史结论：Node 25 变体「当时」未被同一 flag 修好（CHANGELOG）——**实现时必须在当前 Node 25+ 上重新验证**，不得照抄旧结论。

**实现允许的解决路径（按优先级）：**

| 路径 | 说明 | 通过条件 |
| --- | --- | --- |
| P0 复验 liftoff | 在 Node 25+ 上确认现有 `WASM_RUNTIME_FLAGS` + relaunch / worker 继承仍生效 | 多 grammar `index` 与相关测试无 Zone OOM |
| P1 换/增 V8 flag | 若 liftoff 无效或 flag 更名/移除，找到等效「禁用 WASM 优化分层」的 flag，更新 `WASM_RUNTIME_FLAGS` 与单测「flag 在本 runtime 真实存在」的断言 | 同上 |
| P2 架构规避 | 仅当 P0/P1 不可行：例如隔离 grammar 编译到不受该 bug 影响的子进程/预编译策略等（改动大，须在 PR 中说明为何 P0/P1 失败） | 同上，且不回归 22/24 |

**覆盖面检查清单（实现 PR 勾选）：**

- [x] CLI 主入口 relaunch
- [x] parse / store / resolver 等会编译或加载 WASM grammar 的 worker（继承或显式 execArgv）
- [x] `vitest.config.ts` forks `execArgv`
- [x] MCP daemon 启动路径（避免 daemon 落在无 flag 的进程上）
- [x] 文档不再写「Node 25+ blocked」

若验证失败且短期无 P1/P2：不得合并「解除阻断」；可暂时保持阻断并在本 Spec 附录记录失败证据（版本号、复现命令、日志）。

---

## 4. 依赖兼容

### 4.1 Node 18 相关（实现必扫）

| 依赖 | 现状 | 影响 | 处理方向 |
| --- | --- | --- | --- |
| `commander@^14` | `engines: >=20` | 阻塞 | → **`commander@^13`**（`>=18`），CLI 回归 |
| `@clack/prompts@^1.3` | `>=20.12.0`；且 1.2+ 用 `util.styleText` | 阻塞 Node 18 | → **`@clack/prompts@1.0.0`**（picocolors），installer 冒烟 |
| `better-sqlite3@^12` | engines 无 18 | 18 上可能无 native | **降到 `^11.10.0`**（已验证 Node 18/25 可编）；装不上时仍 wasm |
| `vitest@^2.1` | `^18 \|\| >=20` | OK | 保持 |
| 其余（web-tree-sitter 等） | 未见 ≥20 门禁 | 预期 OK | Node 18 / 25 实跑确认 |

### 4.2 Node 25+ 相关

- `better-sqlite3@12` engines 已含 25.x / 26.x——native 路径预期可用。
- 关注 V8 / Node 是否移除或改名 `--liftoff-only`（单测已有「flag 必须存在」类断言时，在 25+ 上跑测即覆盖）。
- 不因「支持 25」去抬高下限；18 与 25+ 的依赖约束取交集。

---

## 5. 文档与测试对齐

- [x] `engines`: `>=18.0.0`（无 `<25`）
- [x] `MIN_NODE_MAJOR === 18`；过旧用例改为 major &lt; 18（如 17.x）
- [x] 删除或改写 Node 25 banner / 硬退出测试；不得再断言「25 必须 exit」
- [x] README / AGENTS / DEVELOPMENT / release 注释：支持 18+；推荐 22.5+；**去掉**「25+ blocked」
- [x] CHANGELOG `[Unreleased]`：支持 Node 18；Node 25+ 取消硬阻断，并说明依赖 WASM runtime flag（或替代方案）避免 Zone OOM
- [x] `wasm-runtime-flags.ts` 顶部注释去掉「Node 25 is already hard-blocked」过时表述

---

## 5.1 多 Node 上跑 UT —— 怎么做

**结论先说：** Vitest / `npm test` **一次进程只绑定一个 Node**。所谓「UT 支持多 Node」= **同一套测试在多个 Node 上各跑一遍**（矩阵），不是单次 vitest 内模拟多个 V8。

### 分层：哪些用例需要真·多版本

| 类型 | 例子 | 是否必须多 Node 实跑 |
| --- | --- | --- |
| 纯逻辑 / 文案 | `buildNodeTooOldBanner` 字符串、`MIN_NODE_MAJOR` 常量 | **否**——任意一个支持 Node 上跑即可 |
| 运行时 API / 原生 | SQLite 后端选择、`node:sqlite` 有无、`--liftoff-only` 是否被本 Node 接受、forks 加载 grammar | **是**——18–25 各 major 行为可能不同，矩阵才能兜住 |
| 派生子进程 CLI | spawn `homegraph` 触发版本门禁、relaunch | **是**——子进程用的是 `process.execPath`（当前矩阵格的 Node） |

现有 `vitest.config.ts` 已对 forks 注入 `--liftoff-only`，并设 `HOMEGRAPH_ALLOW_UNSAFE_NODE=1`。解除 25 阻断后，矩阵格应为「官方支持」版本；**25 格通过不得靠该 env 掩盖 Zone OOM**。

### 本地脚本（硬要求）：`scripts/test-node-matrix.sh`

仓库提供基于 **nvm** 的兼容性矩阵脚本，并由 `package.json` 暴露：

| 项 | 约定 |
| --- | --- |
| 路径 | `scripts/test-node-matrix.sh` |
| npm | `npm run test:node-matrix` |
| **默认 majors** | **`18 19 20 21 22 23 24 25`** |
| 每格动作 | `nvm install <major>` → `nvm use` →（默认）`rm -rf node_modules && npm ci` → `npm run build` → `npm test` |
| 汇总 | 默认跑完全部 major 再汇总；任一失败 exit 1（`FAIL_FAST=1` 可首败即停） |

**用法：**

```bash
# 默认：18–25 全跑
npm run test:node-matrix
# 或
./scripts/test-node-matrix.sh

# 子集
./scripts/test-node-matrix.sh 18 22 25
NODE_MATRIX="18 20 22" ./scripts/test-node-matrix.sh

# 首败即停 / 跳过每格重装（跨 major 不推荐）
FAIL_FAST=1 ./scripts/test-node-matrix.sh
SKIP_INSTALL=1 ./scripts/test-node-matrix.sh 22
```

**约束：**

- 依赖本机已装 [nvm](https://github.com/nvm-sh/nvm)；缺失时脚本报错退出并提示安装。
- **每个 major 独立 `npm ci`**（默认），避免 `better-sqlite3` 等 native 二进制跨 ABI 复用。
- 文档：`DEVELOPMENT.md` 增加一行指向本脚本；实现门禁合入前须有一次默认矩阵（或附录 B 记录的等价跑法）结果。
- Docker 可选补充（无 nvm 的 CI/Linux）：`node:18-bookworm` … `node:25` 各跑同等命令；**不替代**本脚本作为本地默认入口。

### CI（可选增强）

可新增 `.github/workflows/test.yml`，`matrix.node-version: [18, 19, 20, 21, 22, 23, 24, 25]`，`fail-fast: false`；与本地脚本 majors 对齐。release publish job 可仍单 Node 22；**兼容性以 matrix / 本地脚本为准**。

### 套件内：按 major 门控

```ts
const major = Number(process.versions.node.split('.')[0]);

it.runIf(major >= 22)('prefers node:sqlite when available', …);
it.runIf(major === 18)('falls back without node:sqlite', …);
it.runIf(major >= 25)('loads grammars under liftoff without Zone OOM', …);
```

- **门控 ≠ 多版本覆盖**：覆盖率来自脚本/CI 把 18–25 都跑到。
- 门禁文案可造版本号；**Zone / sqlite 不能造**。

### 本需求对 UT 矩阵的默认要求

| 矩阵格 | 最低 UT 期望 |
| --- | --- |
| 18、19 | 全量 `npm test`（允许无 `better-sqlite3` → wasm） |
| 20、21 | 全量 `npm test`（native 或 wasm） |
| 22、23、24 | 全量 `npm test`；≥22.5 期望可走 `node:sqlite` |
| 25 | 全量 `npm test`；加载 tree-sitter grammar 的用例必须绿（Zone 缓解） |

不要求单 vitest 进程切换 Node；**不**引入多 launcher。

---

## 6. 验收标准

**门禁与声明**

- [x] `engines` 为 `>=18.0.0`（无上限）
- [x] Node 17.x 仍硬阻断；18.x **不**过旧退出；25.x **不**再硬阻断
- [x] 文档与代码一致

**Node 18**

- [x] 直接依赖无未处理的 `engines: >=20` 冲突
- [x] Node 18：`build` + **全量** `npm test` 通过（3062 passed，v18.20.8 + better-sqlite3 11 native WAL）；`init`/`status` 成功

**Node 25+（必须）**

- [x] Node **25.x**：全量 `npm test` 通过（3062 passed，v25.9.0）；加载 grammar 无 Zone OOM
- [x] Node 18/25 上 `init` 索引路径可用（空 fixture）；全量套件含 grammar 加载，无 Zone OOM
- [x] 未更换 `WASM_RUNTIME_FLAGS`（P0）；Node 24 installer/version 回归通过
- [x] MCP 相关单测在 Node 25 全量套件中通过（含 daemon/init 路径）

**多 Node UT 编排**

- [x] 存在 `scripts/test-node-matrix.sh` 与 `npm run test:node-matrix`（§5.1）
- [x] 默认矩阵覆盖 **`18 19 20 21 22 23 24 25`**；实现合入前至少完整跑通一次（或附录 B 等价记录）
- [x] 版本相关断言用 `it.runIf(major …)` 门控，不在单进程内假扮多 V8
- [x] `DEVELOPMENT.md` 已指向该脚本

**通用**

- [x] 未引入与本需求无关的行为变更

---

## 7. 待产品确认

| 项 | 选项 | 默认建议 |
| --- | --- | --- |
| 精确下限 | `>=18.0.0` vs 钉 LTS 补丁 | **`>=18.0.0`** |
| engines 上限 | 完全无上限 vs 软上限（如 `<27`）仅防未测 major | **无上限**；靠 §3.4 验证 + 日后 hotfix |
| Node 18 上 better-sqlite3 | A) 仅 wasm vs B) 降级求 native | **已选 B**：`optionalDependencies.better-sqlite3` → **`^11.10.0`**（18/25 均可编过）；无 native 时仍 wasm 兜底 |
| @clack | 钉旧版 vs 换库 | **已钉 `@clack/prompts@1.0.0`**（picocolors；1.2+ 依赖 Node 20+ `util.styleText`） |
| Node 25 banner | 删除 vs 降级为 warn | **删除**硬阻断与 banner |
| 本地/CI 矩阵 majors | 见 §5.1 | **固定默认 `18 19 20 21 22 23 24 25`**（`test-node-matrix.sh`）；CI 可同集合或先子集再扩全；release job 可仍单用 22 |
| 25+ 验证深度 | 单测 + 小 index vs 大仓 index | **至少** 多 grammar 小仓；有条件加大仓 |

已按 §7 默认建议实施；状态 →「已完成」。

---

## 8. 非目标与风险

**非目标：** Node 16；Node 18 上达到 22.5+ 吞吐；永久担保未来一切 Node major 零维护。

**风险：**

1. **依赖降级**（commander / clack）可能带回 CLI/UI 缺陷 → installer 冒烟。
2. **Node 18 + wasm SQLite** 无 WAL → 推荐文案指向 22.5+。
3. **Node 25+ Zone**：若 liftoff 仍无效，解除阻断会把「启动即炸」变成「索引中途炸」——体验更差；故 §3.4 为合并门禁。
4. **无 engines 上限**：用户装到尚未验证的未来 major 时可能再踩 V8 坑 → README 写「推荐 22 LTS」；出现新坑时快速 hotfix。

---

## 9. 建议实现顺序

1. **先在 Node 25+ 上验证** 现有 `--liftoff-only` relaunch 是否已足够（P0）；不够则做 P1/P2，并回归 22/24。
2. 去掉 Node 25 硬阻断与 banner/测试；更新 `wasm-runtime-flags` 注释。
3. Node 18：降 `commander` / `@clack`；`MIN_NODE_MAJOR = 18`；engines 改为 `>=18.0.0`。
4. 文档 + CHANGELOG。
5. 跑 `npm run test:node-matrix`（默认 **18–25**）；并做 `init`/`index`/`status`（及一条 MCP 冒烟）。
6. （可选）CI workflow 对齐同一 major 列表；结果记入附录 B。

---

## 附录 A — 现状锚点（改前）

| 位置 | 当前值 |
| --- | --- |
| `package.json` `engines` | `>=20.0.0 <25.0.0` |
| `MIN_NODE_MAJOR` | `20` |
| Node 25+ | 启动硬退出 + `buildNode25BlockBanner` |
| WASM 缓解 | `WASM_RUNTIME_FLAGS = ['--liftoff-only']` + relaunch；vitest forks 同 flag |
| 文档 | 20+ / `>=20 <25`；CHANGELOG 称 25 仍阻断且 liftoff 未覆盖其变体 |
| ≥20 依赖 | `commander@14`、`@clack/prompts@1.3`；`better-sqlite3@12` 不含 18、含 25/26 |

## 附录 B — 验证记录（实现完成）

| 项 | 内容 |
| --- | --- |
| Node 25 | **v25.9.0** — P0 `--liftoff-only`；全量 `npm test` **3062 passed** / 0 fail；CLI `--help` 无硬阻断 |
| Node 18 | **v18.20.8** — `@clack/prompts@1.0.0` + `better-sqlite3@11.10.0` native WAL；全量 `npm test` **3062 passed**；`init`/`status` Backend=native |
| Node 24 回归 | **v24.14.1** — `node-version-check` + `wasm-runtime-flags` + `installer-targets`（198）通过 |
| 依赖 | `commander@^13.1.0`；`@clack/prompts@1.0.0`；`better-sqlite3@^11.10.0`；`engines: >=18.0.0` |
| 脚本 | `scripts/test-node-matrix.sh` / `npm run test:node-matrix`（默认 18–25） |
