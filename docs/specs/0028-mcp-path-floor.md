# 0028 — MCP `--path` 成为根解析的地板（阻断祖先 `.homegraph` 劫持）


| 字段 | 内容 |
| --- | --- |
| 编号 | 0028 |
| 类型 | 缺陷 / 变更 |
| 状态 | 已完成 |
| 日期 | 2026-09-11 |
| 范围 | `src/directory.ts` `findNearestHomeGraphRoot()`；`src/mcp/engine.ts`；`src/mcp/index.ts` `resolveDaemonRoot()`；单测；CHANGELOG |
| 关联 | [0021](./0021-product-fast-map-and-auto-init.md)（auto-init 管线）；[0027](./0027-explore-zero-file-description.md)（同一次 DevEco 评测暴露的伴生缺陷） |


---

## 1. 背景：一次可完整复现的评测事故

DevEco Code 评测框架在 `harness-bench/result/<run>/<instance>/sample_in_harmonyos` 下启动 MCP server（宿主注入 `--path .`，cwd 即项目目录）。2026-09-10 19:17:28，某次以 `harness-bench/` 仓库根为工作目录的会话执行 auto-init，在仓库根创建了 `harness-bench/.homegraph/`。此后**同一目录树下所有嵌套项目全部失效**，时间线（三场次，死亡时刻与 spawn 时刻差恒为 60s）：

1. `findNearestHomeGraphRoot(项目目录)` 沿祖先链上溯 5 级，命中 `harness-bench/.homegraph` → server 的项目根被解析为**整个 harness-bench 仓库**（daemon 注册表 `root` 字段实锤）；
2. daemon 试图索引整个评测结果树（数百个历史 run 目录），**48 秒烧穿 3.5GB V8 堆**：`FATAL ERROR: Ineffective mark-compacts near heap limit`（`harness-bench/.homegraph/daemon.log` 完整存证）；
3. server 等待 OOM 中的 daemon，首个工具调用无响应；**liveness watchdog（默认 60s）SIGKILL server**，客户端收到 `MCP error -32000: Connection closed`；
4. 项目目录的 `.homegraph` 永不创建（根已"完成"于错误位置），宿主侧验收判"索引未建立"。

18:10 的场次正常（投毒源尚未创建）、19:17 之后的全部场次 100% 失效——确定性目录搜索被祖先残留索引劫持，与负载、node 版本、竞态均无关。

## 2. 目标

- 宿主**显式声明**的根（CLI `--path`，或客户端 `rootUri` 回退）成为根解析的**地板**：server 端解析（engine `doInitialize` / `retryInitializeSync`、daemon 根 `resolveDaemonRoot`）不得采用地板之上的祖先 `.homegraph`；
- 无显式 `--path` 的启动（裸 `serve mcp`、CLI 子命令从子目录上溯）**保留原有 git 式上溯语义**，零行为变化；
- 工具级 `projectPath` 参数的上溯（issue #238 语义）**不受影响**——那是 agent 的逐次显式选择，不属于宿主根声明。

## 3. 非目标

- 不改变 `homegraph init`/`index`/`status` 等 CLI 命令的上溯行为；
- 不为"根确实巨大"的场景加 OOM 缓解（`--liftoff-only` 重执行已是现状）——本修复让错误根不再被采用，而非让错误根可被索引。

## 4. 设计

`findNearestHomeGraphRoot(startPath, floor?)`：

- `floor` 未提供 → 行为与现状逐字节一致；
- `floor` 提供且包含 `startPath` → 上溯**至 floor（含）为止**，floor 自身无 `.homegraph` 即返回 null（→ auto-init 在 host 声明的根上建库）；
- `floor` 不包含 `startPath`（配置错位）→ 忽略地板，退回旧行为（防御式，不因配置错误破坏发现）。

传递链：CLI `--path` / rootUri → `MCPServer(projectPath)` → ① `resolveDaemonRoot(path, floor=path)`；② `engine.rootFloor = path` → `doInitialize`/`retryInitializeSync` 的 `findNearestHomeGraphRoot(searchFrom, rootFloor)`。

语义权衡（有意为之）：宿主传入深层子目录且其父 monorepo 根有索引时，新行为在该子目录 auto-init 建独立索引，而非采用父索引。宿主声明的就是它的项目边界；跨项目查询走工具级 `projectPath` 通道（工具级上溯保留）。

## 5. 验证

- 单测 `test/mcp-path-floor.test.ts`：地板拦截祖先命中 / 地板内子目录正常上溯 / 无地板保持旧行为 / 地板不含起点时忽略 / engine 线缆（带 floor 的 MCPEngine 不采用地板之上索引）；
- 事故场景回归：嵌套目录 + 祖先 `.homegraph` + `serve mcp --path <子目录>` → 在子目录 auto-init，daemon 根为子目录；
- `npm run build` + 相关测试通过。

## 6. 影响

仅 server 端根解析；daemon 根同理收敛。裸启动与 CLI 上溯路径无行为变化。
