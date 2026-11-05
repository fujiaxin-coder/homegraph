# harmony-callgraph-soak (L2 / L3)

实仓浸泡：**不是 vitest**。一条命令对 `applications_photos` 出完整质量报告（Recall / Precision@gold / must-not / 拆分 / L3 带宽 / 覆盖比例 / 公式附录）。

## 跑

```bash
npm run build
npm run soak:photos -- --project D:/code/applications_photos
npm run soak:photos -- --project D:/code/applications_photos --skip-index
```

产物：

- `out/report.html` — **主报告**（关键指标高亮 + 边/节点分类占比）
- `out/report.md` — Markdown 全文（含附录公式）
- `out/report.json` — 全量
- `out/call-graph-quality.json` — 压缩质量产物

## 金标

- `gold/must|must-not/{A–F}-*.json`：约 300 must + 150 must-not（采矿配额）
- 每条：`label: true|false|unknown`、`evidence: file:line`、`kind`、`scope`、`suite`
- **unknown / deferred 不进 P/R 分母**
- 刷新：`node tools/mine-gold-from-source.mjs --project <photos> --write` 后人工抽查

## 覆盖目标（报告内校验）

Must 金标需同时覆盖：

| 维度 | 例子 |
| --- | --- |
| edge kind | calls / imports / extends / implements / contains |
| scope | cross-module / cross-file / same-file |
| suite | prod（为主） |
| scenario bucket | A–F 与 L1 对齐 |

## L2 / L3

见报告 **Appendix A**。calls 只评 `synthesizedBy=arkanalyzer`。L3 对比 `baseline/photos.stats.json`（首次浸泡会自动写入当前快照）。
