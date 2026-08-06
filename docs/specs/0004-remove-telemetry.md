# 0004 — 删除匿名遥测整条链路

| 字段 | 内容 |
| --- | --- |
| 编号 | 0004 |
| 类型 | 变更 |
| 状态 | 已完成 |
| 日期 | 2026-08-06 |
| 范围 | `homegraph` 仓库内匿名遥测客户端、ingest Worker、文档与接线 |
| 关联 | 推翻 [0001](./0001-remove-unused-dirs-and-files.md) 附录 A.2 / A.3 中「遥测整条链路保留」结论 |

---

## 1. 背景与目标

产品决定不再收集匿名使用统计。0001 清理未使用资产时曾确认保留遥测；本 Spec 以产品反向决策为准，删除仓库内整条遥测链路，使默认安装与运行路径**不再记录、缓冲或外发**任何遥测事件。

**目标：**

1. 删除遥测客户端、公开 ingest Worker 源码与用户/设计文档；
2. 拆除 CLI、installer、MCP 上的全部接线（不留 stub）；
3. 删除后构建与相关测试通过；进程默认不会向 `telemetry.gethomegraph.com` 发请求。

---

## 2. 范围

### 2.1 纳入删除

| 路径 / 能力 | 说明 |
| --- | --- |
| `telemetry-worker/` | Cloudflare Worker ingest 源码（整目录） |
| `src/telemetry/` | 客户端模块（整目录） |
| `TELEMETRY.md` | 用户向字段说明 |
| `docs/design/telemetry.md` | 工程契约文档 |
| `test/telemetry.test.ts` | 客户端单元测试 |
| CLI | `preAction` 计数、`recordIndexEvent` / flush、`homegraph telemetry` 子命令 |
| Installer | 同意开关、`install` / `uninstall` lifecycle、flush |
| MCP | `recordUsage`、`startInterval`、仅服务于遥测的 `ClientInfo` 缓存 |

### 2.2 不纳入

- 线上 Cloudflare Worker / DNS / PostHog 项目的运维下线（本仓只删源码）；
- 用户机器上已有 `~/.homegraph/telemetry.json` / queue 文件的主动清理；
- CHANGELOG 已发布历史条目的改写；
- **更新检查**（`src/upgrade/update-check.ts`）及其对 `DO_NOT_TRACK` / `HOMEGRAPH_NO_UPDATE_CHECK` 的尊重。

---

## 3. 行为约束

- 删除后：无遥测模块、无 `homegraph telemetry` 子命令、install 不再询问分享统计。
- `DO_NOT_TRACK` 仍可关闭更新检查（与已删遥测解耦）。
- 交叉引用（注释、评测脚本 env、`vitest.config` 中的 `HOMEGRAPH_TELEMETRY` 等）须清零或改为与更新检查相关的表述。

---

## 4. 验收标准

- [x] 仓库内无上述删除清单中的路径与遥测接线；
- [x] 无 `from '...telemetry'` / `getTelemetry` 等运行时引用残留；
- [x] `npm run build` 通过；受影响测试通过；
- [x] Unreleased CHANGELOG 有用户向说明（遥测已移除）。

---

## 5. 非目标

- 不借机改动 MCP 协议或更新检查逻辑（注释除外）；
- 不在本任务执行 `wrangler` 下线远端 Worker。

---

## 6. 实现状态

状态：**已完成**（2026-08-06）。
