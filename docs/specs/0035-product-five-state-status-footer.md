# 0035 — 产品五态索引 status 短 footer


| 字段 | 内容 |
| --- | --- |
| 编号 | 0035 |
| 类型 | 需求 / 变更 |
| 状态 | 已完成 |
| 日期 | 2026-09-15 |
| 范围 | 产品态 `empty\|fast\|full\|dirty\|syncing`；MCP 短词典；工具返回末尾一行 status；相关单测与 CHANGELOG |
| 关联 | [0032](./0032-product-index-states-and-cold-start.md)（四态基线）；承接「可读但过期 ≠ syncing」 |


---

## 1. 背景与目标

0032 的四态把「有 pending 脏文件但仍可读」混进或漏掉，agent 不易区分。长横幅浪费 token。需要：

1. **五态**：`empty` / `fast` / `full` / `dirty` / `syncing`
2. MCP 描述里 **一行词典**（极短）
3. 工具返回：**不可用 → 整段一行；有正文 → 末尾一行**；正文本身不改长文案

---

## 2. 范围

### 2.1 做

- `ProductIndexState` 增加 `dirty`；短文案与 `formatProductStatusLine` / `PRODUCT_STATUS_GLOSSARY`
- `resolveProductIndexState`：`full` + 有 pending 且非写锁/非本进程 indexing → `dirty`；`syncing` 优先于 `dirty`
- 深工具门控：`dirty` / `full` 放行；`empty`/`fast`(无节点)/`syncing` 仍整段短指引
- 成功工具结果末尾追加 status 行；已是纯 `HomeGraph status=` 指引则不重复
- pending 场景用短 `dirty` footer，**不再**叠旧的长 ⚠️ stale banner/footer（degraded 整库横幅保留）
- `server-instructions` 加一行 glossary；`homegraph_project` 去掉正文里冗长 phase 散文，靠 footer
- 单测 + CHANGELOG `[Unreleased]`

### 2.2 不做

- 不改索引/sync 算法；不改 tools/list 显隐
- 不改 `homegraph_project` 两级详情改版（另案）
- 不引入完整 JSON5（见 0034）

---

## 3. 行为与约束

| status | 含义 | 返回 |
| --- | --- | --- |
| `empty` | 未就绪 | 整段：`HomeGraph status=empty — not ready; retry shortly.` |
| `fast` | 仅地图 | 深工具整段：`… map only; use homegraph_project; retry other tools later.`；`homegraph_project` 正文+同句 footer |
| `full` | 完整最新 | 正文 + `HomeGraph status=full — complete and up to date.` |
| `dirty` | 可读但过期 | 正文 + `HomeGraph status=dirty — outdated: <paths…>`（路径 cap） |
| `syncing` | 写锁/BUSY | 整段：`… locked; retry shortly, do not loop.` |

**优先级：** `syncing` > `empty` > `fast` > `dirty` > `full`

**词典（MCP）：**  
`status: empty=not ready · fast=map only (homegraph_project) · full=fresh · dirty=usable but listed paths outdated · syncing=write lock, retry`

---

## 4. 验收标准

- [x] 五态类型与短文案；glossary 进 server-instructions
- [x] `full`+pending → `dirty`；写锁 → `syncing`（非 dirty）
- [x] 深工具 empty/fast/syncing 整段短指引；dirty/full 可执行且末尾有 status 行
- [x] pending 不再附加长 ⚠️ stale banner（degraded 除外）
- [x] 单测覆盖五态解析、footer、门控；CHANGELOG 已写（commit 待用户）

---

## 5. 风险与回滚

| 风险 | 缓解 |
| --- | --- |
| 去掉长 banner 后 agent 少读细节 | dirty 行列路径；cap 防爆 |
| 与 0032 测试文案漂移 | 更新 `product-index-states` 断言为短句 |

回滚：恢复四态 + 旧 guidance / stale banner。

---

## 6. 非目标

- 模块级摘要进 dirty 行（可选后续；本 Spec 用路径列表）
- 产品态进 JSON structuredContent（仍纯 text）
