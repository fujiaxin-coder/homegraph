# 0046 — Daemon 生命周期日志 + HOMEGRAPH_DEBUG 细粒度


| 字段 | 内容 |
| --- | --- |
| 编号 | 0046 |
| 类型 | 需求 / 变更 |
| 状态 | 已完成 |
| 日期 | 2026-09-21 |
| 范围 | `.homegraph/daemon.log` 粗粒度生命周期；`HOMEGRAPH_DEBUG` 工具级摘要；轮转；单测与 CHANGELOG |
| 关联 | Spec 0028（daemon.log 取证）；0021/0032（auto-init）；DevEco Code MCP 宿主 |
| 非本 Spec | 新建 `logs/` 目录；默认每条 MCP 流水账；宿主 IDE 侧日志；改协议 |


---

## 1. 背景与目标

DevEco Code 等产品以 MCP 挂 HomeGraph。现场常见：**跑着挂了、MCP 没挂好、OOM/watchdog**。已有机制：daemon 的 stdout/stderr **append 到** `.homegraph/daemon.log`（Spec 0028 事故取证即此文件）。但：

1. 关键生命周期事件（起停 / init / index / watchdog）**没有统一、可检索的一行格式**，全靠偶然 console 输出。  
2. 直接模式 / proxy 未把 stderr 接到该文件时，工程内可能**看不到**同套记录。  
3. 细粒度 tool 流水账默认写满盘不合适；排障才需要。

**目标：** 默认只记粗粒度生命周期 + 错误到 **同一** `daemon.log`；`HOMEGRAPH_DEBUG` 打开后追加工具摘要；软轮转防无限涨。

---

## 2. 范围

### 2.1 做

1. **落点不变**：`.homegraph/daemon.log`（相对项目根）。不新建 `logs/`。`.homegraph/` 已在 `.gitignore`。  
2. **`logLifecycle(event, ctx?)`**：始终输出一行（stderr + 若已知 `projectRoot` 则 append 文件）。事件至少覆盖：  
   - `mcp.start`（mode: daemon|proxy|direct + reason）  
   - `mcp.initialize`（ok / fail 摘要）  
   - `auto-init.start` / `auto-init.done` / `auto-init.fail`  
   - `index.start` / `index.done` / `index.fail`（高层，非整文件流水）  
   - `watcher.degraded`  
   - `watchdog.kill`（若本进程能感知；子进程已有 stderr 文案可并存）  
   - `fatal`（uncaught / 显式致命）  
3. **行格式**（稳定、可 grep）：  
   `ISO8601 Z [HomeGraph] <level> <event> key=value …`  
   值短；禁止 dump 源码 / 完整 tool 返回 / 整段 query 超长（query 可截断 ≤80 字符）。  
4. **`HOMEGRAPH_DEBUG`**：为真时，`tools/call` 结束追加一行 `tool.<name>`（耗时 ms、isError、projectRoot、evidenceStatus 若有）。未设则不写工具行。  
5. **软轮转**：append 前若 `daemon.log` ＞约 **5 MiB**，rename 为 `daemon.log.1`（覆盖旧 `.1`），再写新文件。  
6. **单测**：格式、轮转、DEBUG 门控、无 root 时仍 stderr 不抛。

### 2.2 不做

- 默认记录每条 explore query 全文或源码片段  
- 独立 `HOMEGRAPH_LOG_FILE` 路径配置（本版固定 daemon.log）  
- 改 MCP JSON-RPC / initialize 文案  
- 强制 CLI 非 MCP 的每次 `index` 写满阶段（仅高层 start/done/fail）

---

## 3. 行为摘要

| 条件 | 行为 |
| --- | --- |
| 默认 | 生命周期 + error → stderr；有 projectRoot → 同写入 `.homegraph/daemon.log` |
| `HOMEGRAPH_DEBUG` | 另写 tool 摘要行 |
| 文件 ＞5 MiB | 轮转为 `daemon.log.1` |
| 无 `.homegraph` / 无法写文件 | 仅 stderr，不因日志失败中断 MCP |

---

## 4. 验收标准

- [x] Spec 落盘；模块 API + 关键挂载点  
- [x] 单测覆盖格式 / 轮转 / DEBUG 门控  
- [x] CHANGELOG Unreleased  
- [x] 不新增需 gitignore 的平行目录（沿用 `.homegraph/`）

---

## 5. 风险与回滚

| 风险 | 缓解 |
| --- | --- |
| 多进程并发 append 交错 | 一行一写；可接受交错 |
| 轮转竞态丢一行 | 可接受；排障优先有文件 |
| DEBUG 泄露路径 | 仅 debug；截断 query |

回滚：去掉挂载点与 `runtime-log` 模块即可；daemon stdio 重定向保持。

---

## 6. 非目标

- Application 级 APM / 远程上报  
- 替换现有 `logDebug`/`logWarn` 调用点的大规模迁移（可并存；lifecycle 为显式事件）
