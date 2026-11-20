# 0071 — status 以 indexed_at_commit 时间戳检测已提交变更

| 字段 | 内容 |
| --- | --- |
| 编号 | 0071 |
| 类型 | 缺陷修复 |
| 状态 | 已完成 |
| 日期 | 2026-11-20 |
| 范围 | `src/extraction/index.ts`（`getGitChangedFiles` / `collectGitStatus` / `getChangedFiles` / `beginGitIndexState` / `finishGitIndexState` / `canTrustGitFastPath` / `gitCommittedChangesSince` / `getGitHeadSha` / `readOnlyGitEnv`）；`src/index.ts`（`indexAll` / `sync` 的 stamp 生命周期）；测试 `test/sync.test.ts` 新用例；CHANGELOG |
| 非本 Spec | sparse-checkout 变更检测（`indexed_sparse_checkout`，独立跟进）；`includeIgnored` 嵌入仓库递归策略（保持现状）；全量 `indexAll` 的路径不变 |

---

## 1. 背景

`homegraph status` 的变更检测走 git fast path：`getChangedFiles()` → `getGitChangedFiles()` → `git status --porcelain`。`git status` 只描述**工作树 vs 暂存区/HEAD** 的差异，因此：

1. **commit 后**：工作树与 HEAD 一致，`git status` 为空 → `totalChanges = 0` → status 报 `[OK] Index is up to date`。但索引从未跟上新 commit 的内容（索引里还是旧文件的 contentHash），**误报**。
2. **merge / checkout / pull 后**：同样工作树干净 → 同样误报。
3. **`.gitignore` 修改后**：`.gitignore` 非源文件被 `isSourceFile` 过滤，且已索引文件在新规则下应被排除却残留 → status 报 up to date，实际索引与当前规则不一致（sync 会正确 `Removed`）。

根因：**status 把「git 工作树干净」当作「索引最新」的充分条件**。代码变更一旦通过「让工作树变干净」的方式进入（commit/merge/checkout/gitignore），status 就永远假报 up to date。sync 因走全量扫描（`scanDirectoryAsync` + 逐文件哈希对比）而诚实，进一步证实 status 的检测器不可信。

## 2. 目标

- `homegraph status` 在 **commit / merge（含 fast-forward）之后**如实报告 `Pending Changes`，而不是 `Index is up to date`。
- 对 git 历史被改写（rebase / force-push / 浅克隆 / stamp 丢失）的场景**拒绝信任 git fast path**，退回全量扫描，不误报。
- 崩溃（sync 中途被杀）不丢「已索引的未提交改动」记录，避免下次 status 假报。

## 3. 方案（对齐 codegraph #1829）

### 3.1 新增元数据 stamp

`src/extraction/index.ts` 新增：

```ts
export const INDEXED_AT_COMMIT_KEY = 'indexed_at_commit';
```

- 语义：**索引最后一次跟上到哪个 commit（HEAD sha）**。
- 写入时机：全量 `indexAll` 成功结束、`sync` 成功结束。
- 老索引无此 stamp → `canTrustGitFastPath` 返回 false → 走一次全量扫描兜底，之后 sync/index 写入 stamp，快路径恢复。

### 3.2 git 辅助函数

```ts
export function getGitHeadSha(rootDir: string): string | null
```
`git rev-parse HEAD`，非 git 仓库或无 commit 返回 null。

```ts
function readOnlyGitEnv(): NodeJS.ProcessEnv
```
`{ ...process.env, GIT_OPTIONAL_LOCKS: '0' }` —— 变更检测只读，避免与用户 `git add`/`checkout` 争 `.git/index.lock`。

```ts
function gitCommittedChangesSince(repoDir: string, sinceCommit: string): string[]
```
`git diff --relative --name-status --no-renames -z <sinceCommit> HEAD -- .`，NUL 分隔的 `status\0path` 对。`sinceCommit === HEAD` 时为空（常见热路径，一次廉价 git 调用）。

### 3.3 信任判定

```ts
export function canTrustGitFastPath(rootDir: string, sinceCommit?: string | null): boolean
```

- HEAD 为 null（无 commit / 非 git 仓库）→ true（每文件皆 untracked，`git status` 全覆盖）。
- stamp 缺失（老索引，但仓库有 commit）→ false（全量扫描兜底）。
- stamp === HEAD → true。
- 否则 `git cat-file -e ${sinceCommit}^{commit}` 校验 stamp 是否仍存在于仓库；存在 → true，不存在（rebase/gc/浅克隆/跨 checkout）→ false。

### 3.4 getGitChangedFiles 增加 sinceCommit

```ts
function getGitChangedFiles(rootDir: string, sinceCommit?: string | null): GitChanges | null
```

- 收集工作树变更（原有 `git status --porcelain`）。
- `sinceCommit` 存在时**额外**收集 `sinceCommit..HEAD` 的已提交变更（`gitCommittedChangesSince`），按同一 `classify` 规则过滤（source 文件、ignore、exclude、deleted 不过滤）。
- `collectGitStatus` 重构：抽 `classify(statusCode, rel)` 单一分类器，工作树与已提交两个来源共用，保证过滤规则一致（#766/#999/#1829）。

### 3.5 getChangedFiles 组装候选集

```ts
getChangedFiles(): { added; modified; removed } {
  sinceCommit = queries.getMetadata(INDEXED_AT_COMMIT_KEY) ?? null;
  dirtyPaths = this.indexedDirtyPaths(sinceCommit);
  gitChanges = dirtyPaths !== null && canTrustGitFastPath(rootDir, sinceCommit)
    ? getGitChangedFiles(rootDir, sinceCommit)
    : null;
  if (gitChanges) {
    candidates = new Set([...gitChanges.deleted, ...gitChanges.modified,
                          ...gitChanges.added, ...dirtyPaths]);
    for (filePath of candidates) {
      // git 只供候选，最终判定看磁盘 vs DB：
      // 不存在/非 source → tracked ? removed
      // 内容哈希 ≠ DB → modified；DB 无此文件 → added
    }
  } else {
    // 全量扫描兜底（现状逻辑不变）
  }
}
```

关键：**git 只提供候选集，最终 verdict 始终是「当前磁盘内容哈希 vs 索引 DB」**。commit/merge 的变更经 `sinceCommit..HEAD` diff 进入候选集后，哈希比对发现 DB 旧 → 报 pending。

### 3.6 崩溃保护：indexed_dirty_paths

`src/extraction/index.ts` 新增两个私有方法 + 两个公开方法：

```ts
private indexedDirtyPaths(stamp: string | null): string[] | null
beginGitIndexState(full: boolean): { head; stamp; dirty; sparse }
finishGitIndexState(snapshot, full: boolean, retries: string[] = []): void
```

- `beginGitIndexState`（写盘前调用）：记 `head`、当前 `stamp`、`indexed_dirty_paths`（`JSON {commit, paths}`，含 prior dirty + 当前 git 变更）。
  - full（全量 index）或 prior 缺失 → 清空 stamp 与 dirty（full index 后整体重写）。
  - scoped sync（partial paths）→ **不动 commit stamp**，保留 dirty paths，崩溃后不丢已索引的未提交编辑。
- `finishGitIndexState`（成功后调用）：重算 `after = getGitChangedFiles()`，写入 `{commit, paths}`（dirty + after 的 added/modified/deleted + retries）；`full` 时写 `INDEXED_AT_COMMIT_KEY = head`。
- 写入顺序：先写 dirty paths 再写 commit stamp，组成「撕裂即失败」配对，读者校验 `state.commit === stamp` 不匹配即拒绝。

调用点（`src/index.ts`）：
- `indexAll`：`beginGitIndexState(true)` 在 `index_state='indexing'` 之前；`finishGitIndexState(gitState, true)` 在成功收尾处（参照 codegraph 的 success 判定）。
- `sync`：`beginGitIndexState(fullReconcile)` 在 `orchestrator.sync` 之前；`finishGitIndexState(gitState, fullReconcile, result.failedFilePaths)` 在 resolve 全部完成后。

## 4. 行为矩阵

| 场景 | 改动前 | 改动后 |
| --- | --- | --- |
| 改代码未提交 | Pending Changes（正确） | 不变 |
| 改代码 → sync（未提交） | Pending（git 仍报 M）| 不变（git 候选 + 哈希一致 → 不算 pending）|
| **commit（未 sync）** | **up to date（误报）** | **Pending Changes（已提交变更经 diff 进入候选，哈希不一致）** |
| **merge / ff merge（未 sync）** | **up to date（误报）** | **Pending Changes** |
| sync 后 commit | up to date（正确，stamp=HEAD，diff 空）| 不变 |
| **`.gitignore` 排除已索引文件** | **up to date（误报）** | 视 repo 而定：gitignore 非源文件不进候选，但已提交的排除变更若在 `sinceCommit..HEAD` 中会被检出（sync 后正确 Removed）；未提交的 gitignore 修改本身仍不可见（与全量 index 语义一致，非本 Spec 范围）|
| rebase / force-push（stamp 变孤儿）| 可能误报 | `cat-file -e` 失败 → 全量扫描兜底 |
| 老索引（无 stamp）| 误报 | `canTrustGitFastPath` false → 全量扫描兜底，之后写 stamp |
| sync 中途崩溃 | 可能丢未提交改动记录 | `indexed_dirty_paths` 保留，下次 status 仍报 pending |

## 5. 验收

- [x] Spec 落盘
- [x] `src/extraction/index.ts`：新增 `INDEXED_AT_COMMIT_KEY`、`getGitHeadSha`、`readOnlyGitEnv`、`gitCommittedChangesSince`、`canTrustGitFastPath`、`getGitChangedFiles(rootDir, sinceCommit)`、`collectGitStatus(..., sinceCommit)`、`getChangedFiles` 候选集重写、`beginGitIndexState`/`finishGitIndexState`/`indexedDirtyPaths`
- [x] `src/index.ts`：`indexAll` / `sync` 接入 begin/finish
- [x] 单元测试（`test/sync.test.ts`）覆盖：commit 后 pending；merge（含 ff）后 pending；stamp 缺失兜底；stamp 孤儿（fake sha）兜底；dirty paths 配对校验拒绝；sync 后 commit 报 up to date
- [x] `npm run build` 通过
- [x] `npx vitest run test/sync.test.ts` 全绿（44 passed）
- [x] 手工验证：对真实仓库 commit 后 `homegraph status` 报 Pending，sync 后恢复 up to date
- [x] CHANGELOG.md `[Unreleased]` Fixes 条目
