# 0052 — MCP 在 Bun 下跳过 V8 WASM relaunch


| 字段 | 内容 |
| --- | --- |
| 编号 | 0052 |
| 类型 | 变更 |
| 状态 | 已完成 |
| 日期 | 2026-10-08 |
| 范围 | CLI / MCP 启动时的 WASM runtime relaunch（`wasm-runtime-flags`）；Bun 检测；单测与 CHANGELOG |
| 关联 | Spec 0031（runtime pack）；DevEco Code 用宿主 Bun 拉起 `homegraph.js`（档 A，不另装 Node ≥22） |
| 非本 Spec | 将 HomeGraph 迁入 Bun 原生打包；改 SQLite / tree-sitter 语义；DevEco 通用 MCP 前缀逻辑；`HOMEGRAPH_MCP_SHORT_TOOL_NAMES`（已另提交） |


---

## 1. 背景与目标

产品宿主（DevEco Code）本身以 **Bun** 运行，希望内置 HomeGraph MCP 用 **`process.execPath`（宿主 Bun）** 执行 `dist/bin/homegraph.js`，不再依赖外置 Node ≥22。

HomeGraph 在 Node 上会为 tree-sitter WASM 做一次带 `--liftoff-only` / `--max-old-space-size` 的 **V8 进程 relaunch**。这些标志只对 V8 有意义；在 Bun（非 V8）上 relaunch 无效，且可能干扰子进程生命周期。

**目标：**

1. 检测到 **Bun runtime** 时，**跳过** WASM relaunch，原地继续启动 MCP/CLI。  
2. Node 路径行为不变（仍 relaunch，仍可用 `HOMEGRAPH_WASM_RELAUNCHED` / `HOMEGRAPH_NO_RELAUNCH`）。  
3. 不改变索引、查询、工具 schema 语义；仅启动路径兼容 Bun 宿主。

---

## 2. 范围

### 2.1 做

- `isBunRuntime()`：`globalThis.Bun` 存在即为 Bun（可注入假对象单测）。  
- `relaunchWithWasmRuntimeFlagsIfNeeded`：在既有 guard 之后、`spawnSync` 之前，若 `isBunRuntime()` 则 **return**（不 relaunch）。  
- 单测覆盖 `isBunRuntime` true/false。  
- CHANGELOG `[Unreleased]` Improvements 记一笔。

### 2.2 不做

- 在 Bun 上实现等价于 `--liftoff-only` 的 WASM 策略（当前无对应开关）。  
- 修改 `engines` 声明为正式支持 Bun 作为唯一 runtime（Node 仍是文档主路径；Bun 为产品宿主兼容）。  
- 改 DevEco 通用 `clientName_toolName` 拼接（宿主侧另案）。  
- 进程内嵌 HomeGraph（非 MCP 子进程）。

---

## 3. 行为与约束

### 3.1 启动矩阵

| 运行时 | WASM relaunch |
| --- | --- |
| Node，缺 V8 标志 | relaunch 一次（既有行为） |
| Node，已有标志 / `HOMEGRAPH_WASM_RELAUNCHED` / `HOMEGRAPH_NO_RELAUNCH` | 不 relaunch（既有） |
| Bun（`globalThis.Bun`） | **不 relaunch**（本 Spec） |

### 3.2 约束

- Bun 检测必须可单测（不依赖本机是否安装 Bun 跑 vitest）。  
- 跳过 relaunch **不得**改变 tools/list、tools/call 或索引语义。  
- 宿主仍可设置 `HOMEGRAPH_WASM_RELAUNCHED=1` 作双保险；本 Spec 下即使未设置，Bun 也不应进入 V8 relaunch。  
- Node ≥22 版本门禁保持不变；Bun 下 `process.versions.node` 为兼容字段，不以该字段单独拒绝 Bun。

---

## 4. 验收标准

- [x] Spec 落盘（本文件）  
- [x] `isBunRuntime` 在有/无 `Bun` 时断言正确  
- [x] Bun 下 `relaunchWithWasmRuntimeFlagsIfNeeded` 不 `spawnSync` relaunch（由 `isBunRuntime` 早退保证）  
- [x] 手工 / 脚本：Bun 执行 `serve mcp` 可 `initialize` + `tools/list` + `tools/call` explore  
- [x] CHANGELOG Unreleased  

---

## 5. 风险与回滚

| 风险 | 缓解 |
| --- | --- |
| Bun 上大仓 WASM 内存行为与 Node+liftoff 不同 | 产品仓规模内 spike 已通；异常再开 Bun 专项，不回退误伤 Node |
| 误把非 Bun 判成 Bun | 仅认 `globalThis.Bun`；Node 无该全局 |
| 宿主仍传无效 V8 flag 给 Bun | relaunch 已跳过；宿主侧可设 `HOMEGRAPH_WASM_RELAUNCHED=1` 避免旧逻辑路径 |

回滚：删除 `isBunRuntime` 早退，恢复仅按 V8 flag / env guard 决定 relaunch。
