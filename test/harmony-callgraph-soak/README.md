# harmony-callgraph-soak (L2 / L3)

实仓浸泡：**不是 vitest**。一条命令对 `applications_photos` 建索引，对照人审 JSON 金标算 L2，对照 baseline 算 L3，写出报告。

## 跑

```bash
npm run build
npm run soak:photos -- --project D:/code/applications_photos
# 已有 .homegraph 时跳过重索引：
npm run soak:photos -- --project D:/code/applications_photos --skip-index
```

报告：`test/harmony-callgraph-soak/out/report.md` + `report.json`。

## 布局

| 路径 | 作用 |
| --- | --- |
| `fixtures/photos.lock.json` | 仓 URL + 固定 commit |
| `gold/must/{A–F}-*.json` | ~200 条 must（源码级） |
| `gold/must-not/{A–F}-*.json` | ~100 条 must-not |
| `gold/schema.json` | 边字段约定 |
| `baseline/photos.stats.json` | L3 规模指纹（首次浸泡后从 candidate 审入） |
| `lib/*` | clone / index / match / L2 / L3 / report |
| `run.mjs` | 入口 |
| `tools/mine-gold-from-source.mjs` | **只读源码**采矿（不读 HG）；产出后仍需人审 |

## 六桶（与 L1 对齐）

| 桶 | 含义 |
| --- | --- |
| A | 跨模块 calls |
| B | 同文件未 export helper |
| C | 扇出：must=真实热点调用；must-not=禁止洪水 |
| D | 同模块清晰调用 |
| E | lifecycle / UI（aboutToAppear、build…） |
| F | imports / extends / implements |

## 金标纪律

- 键：`kind` + `file` + `name`（+ 可选行号），**不绑 %AM / 边总数**。
- 真值来自源码（采矿脚本只做候选）；**禁止用当前 HG 边倒推成 must**。
- HG 已知错：把边 `status` 改为 `"deferred"`，填 `"bug": "…"`，报告仍列出但不计入 active 指标。
- 刷新金标：改 lock commit → 跑 `mine-gold-from-source.mjs --write` → **人工抽查** → 再 soak。

## L2 / L3

- **L2**：分桶 must recall、must-not hold rate、漏边/脏边样例、deferred 跟踪。
- **L3**：nodes/edges/calls/扇出 Top / 零 calls 文件 相对 `baseline/photos.stats.json` 的 Δ%（ok/warn/alert）。无 baseline 时写出 `out/photos.stats.candidate.json`。
