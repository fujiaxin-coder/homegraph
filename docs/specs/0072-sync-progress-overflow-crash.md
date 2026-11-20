# 0072 — sync 进度越界导致 CLI 崩溃

| 字段 | 内容 |
| --- | --- |
| 编号 | 0072 |
| 类型 | 缺陷修复 |
| 状态 | 已完成 |
| 日期 | 2026-11-20 |
| 范围 | `src/extraction/index.ts`（sync reconcile 的两个循环独立计数）；`src/ui/shimmer-worker.ts`（`renderBar` / `render` 越界兜底）；测试 `test/shimmer-progress.test.ts`（新增）；`test/sync.test.ts`（进度事件不变量）；CHANGELOG |
| 非本 Spec | `shimmer-progress.ts` 的 percent 计算（保持 `Math.round(current/total*100)`，由渲染层兜底）；`node:sqlite` 相关；sync 的 reconcile 算法本身（不改语义） |

---

## 1. 背景

在文件数越过 `SYNC_RECONCILE_YIELD_INTERVAL`（1000）的仓库（实测 `D:\code\arkanalyzer`，1059 个源文件）执行 `homegraph sync`，进程以未捕获异常崩溃：

```
[HomeGraph] Uncaught exception: RangeError: Invalid count value: -22
    at String.repeat (<anonymous>)
    at renderBar (dist/ui/shimmer-worker.js:58:37)
    at Timeout.render (dist/ui/shimmer-worker.js:77:83)
```

（该堆栈由在 CLI 之外直接挂 `process.on('uncaughtException')` 复现得到 —— CLI 的 `fatal-handler` 按设计只打印 `name: message`，不读 `.stack`。）

### 根因

两个缺陷叠加：

**1. 进度事件 `current` 会超过 `total`（源头）**

`src/extraction/index.ts` 的 sync reconcile 用**一个** `reconcileChecks` 跨越两个循环累计：

```ts
let reconcileChecks = 0;
for (const tracked of trackedFiles) {          // 循环一：removed，遍历 DB tracked 文件
  ...
  if (++reconcileChecks % 1000 === 0) await setImmediate(...);
}
for (const filePath of currentFiles) {         // 循环二：adds/mods，遍历磁盘文件
  if (++reconcileChecks % 1000 === 0) {
    onProgress?.({ phase: 'scanning', current: reconcileChecks, total: currentFiles.length });
    ...
  }
}
```

`reconcileChecks` 是两个循环的**累计检查次数**，而 `total` 只是 `currentFiles.length`。当 DB 里的 tracked 文件数与磁盘文件数接近或大于 1000 的整数倍时，循环二的 `reconcileChecks` 会越过 `total`：

实测 arkanalyzer：tracked=1059、`currentFiles.length`=1059，`reconcileChecks` 在循环二走到 **2000** 时上报 `{current: 2000, total: 1059}`。

**2. 渲染层不防御越界 percent（放大器）**

```ts
// shimmer-progress.ts
percent = Math.round((progress.current / progress.total) * 100);   // 2000/1059 → 189

// shimmer-worker.ts
const filled = Math.round(barWidth * currentPercent / 100);         // 25 * 189/100 → 47
const empty = barWidth - filled;                                    // 25 - 47 → -22
renderBar(frame, filled, empty);
// renderBar: G.barEmpty.repeat(empty) → '░'.repeat(-22)
//            → RangeError: Invalid count value: -22
```

`String.prototype.repeat` 对负值抛 `RangeError`。一个 UI 进度条把整个 sync 进程打死了。

### 为什么小仓库不崩

`reconcileChecks` 不会越过 `total`：文件数 < 1000 时两个循环加起来也到不了下一个 1000 的倍数，进度事件根本不触发。

### 与上游的关系

`D:\code\codegraph` **没有这个缺陷**：它的三个 reconcile 循环只做 `setImmediate` yield，从不上报进度（`reconcileChecks` 由 #905 引入，用途只是让出主线程）。进度上报是 HomeGraph fork 后自行添加的。codegraph 的 `renderBar` 同样没有 clamp，但因为没有越界数据源，不会崩 —— 属于潜在隐患，本次一并加固。

## 2. 目标

- 文件数越过 1000 的仓库执行 `homegraph sync` 不再崩溃，进度条正常渲染。
- 进度事件的 `current` 永不超过 `total`（源头修复）。
- 渲染层对任何越界 percent 都健壮：不抛异常、不输出负长度（防御修复，纵深防护）。

## 3. 方案

### 3.1 源头：两个循环独立计数

`src/extraction/index.ts` sync reconcile：

- **循环一（removed）**保留独立的 yield 计数 `removedChecks`，只用于 `setImmediate`，不上报进度 —— 它遍历的是 DB 里**上一轮**的文件集，与本次磁盘扫描的进度无关。
- **循环二（adds/mods）**用独立计数 `addedChecks`，`current: addedChecks`，`total: currentFiles.length`。`addedChecks` 从 1 起，上限就是 `currentFiles.length`，**恒满足 `current <= total`**。

```ts
let removedChecks = 0;
for (const tracked of trackedFiles) {
  ...
  if (++removedChecks % SYNC_RECONCILE_YIELD_INTERVAL === 0) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

let addedChecks = 0;
for (const filePath of currentFiles) {
  if (++addedChecks % SYNC_RECONCILE_YIELD_INTERVAL === 0) {
    onProgress?.({ phase: 'scanning', current: addedChecks, total: currentFiles.length });
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  ...
}
```

两个 `setImmediate` yield 都保留（#905 的合作式让出语义不变），只是进度改用独立的、与 `total` 同量纲的计数。

### 3.2 防御：渲染层 clamp

`src/ui/shimmer-worker.ts`：

- `render()` 里对 percent 先 clamp 再算 filled：
  ```ts
  const pct = Math.min(100, Math.max(0, currentPercent));
  const filled = Math.round(barWidth * pct / 100);
  const empty = Math.max(0, barWidth - filled);
  ```
  显示用的百分号也改用 clamp 后的 `pct`，避免出现 `189%` 这种输出。
- `renderBar()` 自身也对入参做 `Math.max(0, ...)`：
  ```ts
  function renderBar(frame: number, filled: number, empty: number): string {
    const f = Math.max(0, Math.floor(filled) || 0);
    const e = Math.max(0, Math.floor(empty) || 0);
    if (f === 0) return `${DM}${G.barEmpty.repeat(e)}${RST}`;
    ...
  }
  ```
  两层防护：调用点保证语义正确，函数自身保证任何输入都不越界。

## 4. 行为矩阵

| 场景 | 改动前 | 改动后 |
| --- | --- | --- |
| 文件数 < 1000，sync | 正常（进度不触发） | 不变 |
| 文件数 1059（tracked≈磁盘数），sync | **崩：`Invalid count value: -22`** | 正常渲染，percent ≤ 100 |
| tracked 数 >> 磁盘数（大量删除），sync | 崩（`current` 超出更多） | 正常，`current` 上限 = `currentFiles.length` |
| 任何来源的 percent > 100 或 < 0 | 崩 | 渲染层 clamp，最差渲染空条，不抛 |
| codegraph 同源代码 | 无此缺陷（不发进度） | 不变（本 Spec 只改 HomeGraph） |
| #905 的 yield 语义 | 每 1000 次让出主线程 | 不变（两个循环各自让出） |

## 5. 验收

- [x] Spec 落盘
- [x] `src/extraction/index.ts`：`reconcileChecks` 拆为 `removedChecks` / `addedChecks`，进度只由循环二上报且 `current <= total`
- [x] `src/ui/shimmer-worker.ts`：`render()` clamp percent 与 filled/empty；`renderBar()` 自身对 `filled`/`empty` 取 `Math.max(0, ...)`
- [x] 单元测试 `test/progress-bar.test.ts`（16 passed）：`renderBar` 对负 `empty` 不抛、对 189% 渲染不越界；`render()` 的 percent clamp
- [x] 单元测试 `test/sync.test.ts`（2 passed，含负向对照）：跨 1000 文件的 sync 进度事件满足 `current <= total`
- [x] `npm run build` 通过
- [x] `npx vitest run test/sync.test.ts test/progress-bar.test.ts` 全绿（62 passed）
- [x] 手工验证（1059 文件与 1090 文件仓库均通过；旧版同仓库崩 `-21`）：`D:\code\arkanalyzer`（1059 文件）执行 `homegraph sync` 不崩
- [x] CHANGELOG.md `[Unreleased]` Fixes 条目
