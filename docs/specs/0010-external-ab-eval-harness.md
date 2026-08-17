# 0010 — A/B 测评文档（外部仓入口）


| 字段 | 内容 |
| --- | --- |
| 编号 | 0010 |
| 类型 | 文档 |
| 状态 | 已完成 |
| 日期 | 2026-08-17 |
| 范围 | 在本仓增加「测评怎么做」指南；操作细节仍在外部仓 README |
| 关联 | 实现：[docs/how-to-evaluate.md](../how-to-evaluate.md)；索引：[docs/README.md](../README.md) |


---

## 1. 背景与目标

DevEco / ArkTS 场景的 A/B 工具在独立仓，本仓缺一份入口文档。目标：读者能选对体系并跳到对应 README，**不**在本仓复制脚本与参数表。

---

## 2. 范围

### 纳入

- 新增 [docs/how-to-evaluate.md](../how-to-evaluate.md)
- [docs/README.md](../README.md) 入口表增加一行

### 不纳入

- 不把 `homegraph_eval` / `arkts_benchmark` 合入本仓
- 不改运行时 / MCP

---

## 3. 验收

- [x] `docs/how-to-evaluate.md` 写清三套测评入口与外链
- [x] `docs/README.md` 已挂链
- [x] 无大段参数/脚本镜像

---

## 4. 回滚

删除 `docs/how-to-evaluate.md` 并去掉 README 索引行即可。
