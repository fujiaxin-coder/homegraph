# 0074 — ignore 规则补齐 git 的完整来源与 lone `!` 防护

| 字段 | 内容 |
| --- | --- |
| 编号 | 0074 |
| 类型 | 缺陷修复 |
| 状态 | 已完成 |
| 日期 | 2026-11-20 |
| 范围 | `src/extraction/default-ignore.ts`（`readGitignorePatterns` 过滤 lone `!`；新增 `readGitExcludeExtraPatterns` / `resolveGitDir`；`buildDefaultIgnore` 合并额外来源）；测试 `test/gitignore-sources.test.ts`（新增）；CHANGELOG |
| 非本 Spec | #2849（嵌套同名目录误杀）—— **实测在 HomeGraph 不复现**，见 §1.3，不修；`ScopeIgnore` 的 watcher 侧剪枝（`git ls-files -i` 路径，独立机制）；`includeIgnored` / `exclude` / `include` 三类项目级 matcher（行为不变） |

---

## 1. 背景

`buildDefaultIgnore` 是"什么算项目源码"的单一事实源，被全量扫描、增量 sync、`status` 变更检测共用。它当前只合并两个来源：内置默认规则 + 根目录 `.gitignore`。

而 git 判定"什么被忽略"用的是**四个**来源。缺的两个会让 HomeGraph 索引到 git 认为不该进版本库的文件。

### 1.1 缺陷一：`.git/info/exclude` 与 `core.excludesFile` 完全不可见

实测（`/tmp/ig-exclude`，`.git/info/exclude` 写 `generated/`）：

```
$ git check-ignore -v generated/g.ts
.git/info/exclude:1:generated/	generated/g.ts     ← git 忽略

$ buildDefaultIgnore('.').ignores('generated/g.ts')
false                                              ← HomeGraph 不忽略，会索引
```

两者都是**用户显式配置的忽略规则**，只是不写进 `.gitignore`。常见用途：

- `.git/info/exclude` —— 个人本地排除（不想提交到 `.gitignore` 的私有目录、本地实验文件、编辑器临时产物）
- `core.excludesFile`（默认 `~/.config/git/ignore`）—— 跨所有仓库的全局排除（OS 垃圾文件 `.DS_Store`、IDE 目录、密钥文件）

后果：这些目录下的文件被索引进图。用户主动排除的东西出现在 `search` / `explore` 结果里；密钥、私有大目录被读进 SQLite。

**注意 `git` 语义**：`.git/info/exclude` 与 `core.excludesFile` 的规则和 `.gitignore` **同格式、同优先级**，都是"默认忽略"，都可以被 `.gitignore` 里的 `!` 反向覆盖（`.gitignore` 优先级更高）。

### 1.2 缺陷二：lone `!` 行把整棵 ignore 树反转

`.gitignore` 里单独一行 `!` 没有任何模式可反转。git 视它为**无操作**（空模式）。`ignore` 库则把它编译成"反转一切"，于是**所有**规则失效。

实测（`/tmp/ig-lone`，`.gitignore` 为 `node_modules/\n!\n`）：

```
node_modules/pkg/index.ts ignored? false   ← 依赖树被整棵拉进索引
```

对照（去掉 lone `!`）：

```
node_modules/pkg/index.ts ignored? true    ← 正确
```

后果：手抖多敲一个 `!`，或从别人那里复制了残缺的 `.gitignore`，整个项目的忽略体系崩溃——`node_modules`、`dist`、`build` 全部被索引。这是**灾难性**的：一个大 JS 项目的 `node_modules` 可能有几十万文件。

### 1.3 关于 #2849（嵌套同名目录）—— 实测不复现，本 Spec 不修

codegraph 的 `#2849` 描述"顶层 `lib/` 被 ignore 后，子目录里所有的 `lib/` 也被误杀"。在 HomeGraph 上实测**未复现**：

```
# .gitignore 写 /lib/ （锚定根目录）
$ git check-ignore -q packages/app/lib/b.ts   → 不忽略
$ HomeGraph 索引结果                            → 索引了 packages/app/lib/b.ts   ✅ 一致
```

而 `.gitignore` 写 `lib/`（无前导 `/`）时，git **本身**就把任意层级的 `lib/` 都忽略（这是 git 的既定语义，不是 bug）：

```
$ git check-ignore -v packages/app/lib/b.ts
.gitignore:1:lib/	packages/app/lib/b.ts      ← git 自己就忽略了
$ HomeGraph                                    → 同样忽略        ✅ 一致
```

两种写法 HomeGraph 都与 git 一致。codegraph 的 `#2849` 修的是它自己的 `excludeBuildOutputUnderSrc` 特例逻辑（把 `src/build/` 放行），HomeGraph 没有那段逻辑，因此没有对应缺陷。**本 Spec 不引入该改动**——凭空加一个"修"会引入真实回归。

## 2. 目标

- `.git/info/exclude` 与 `core.excludesFile` 的规则参与 ignore 判定，与 `git check-ignore` 一致。
- lone `!`（以及其他空模式行）不再反转整个 matcher。
- 保持 `.gitignore` 对额外来源的覆盖能力（`!` 反向规则仍有效）。
- 所有额外来源的读取都是**尽力而为**：非 git 仓库、git 未安装、超时、文件不可读，一律静默跳过，绝不让索引失败。

## 3. 方案

### 3.1 `readGitignorePatterns`：过滤空模式

在返回前剔除"只有 `!`"和"只有空白/`!`+空白"的行：

```ts
/**
 * Drop patterns with no content after the negation prefix. A lone `!` (or
 * `!   `) names nothing to re-include, so git treats it as a no-op — but the
 * `ignore` library compiles it into "negate everything", silently disabling
 * every rule above it.
 */
function dropEmptyPatterns(content: string): string {
  return content
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '!' )
    .join('\n');
}
```

在 `readGitignorePatterns` 的两个返回点（快路径 `content`、慢路径 `kept.join('\n')`）都套一遍。这同时修好 `.gitignore`、`.git/info/exclude`、`core.excludesFile` 三个来源——它们都走这个函数。

### 3.2 新增 `resolveGitDir`

```ts
/** The repository's `.git` directory, or null outside a repo. */
function resolveGitDir(rootDir: string): string | null
```

用 `git -C <rootDir> rev-parse --absolute-git-dir`，失败返回 null。用 `--absolute-git-dir` 而非拼 `rootDir/.git`，以覆盖 worktree（`.git` 是文件）与 submodule。

### 3.3 新增 `readGitExcludeExtraPatterns`

```ts
function readGitExcludeExtraPatterns(rootDir: string): string
```

按 git 的顺序收集，`\n` 连接：

1. `<gitDir>/info/exclude` —— 存在则读（走 `readGitignorePatterns` 的容错）
2. `git config --get core.excludesFile` —— 有值则展开 `~` 后读

任一步失败静默跳过。`expandUserPath` 处理 `~/` 前缀（git 允许配置里写 `~/.gitignore_global`）。

### 3.4 `buildDefaultIgnore` 合并顺序

**顺序在实现阶段被测试纠正过。** 最初按"`.gitignore` 先加、额外来源后加"实现，测试立刻发现 `.gitignore` 的 `!src/**` 无法覆盖 `info/exclude` 的 `src/**`——因为 `ignore` 库里**后加的规则优先级更高**。git 的优先级恰好相反（`.gitignore` 最高），所以额外来源必须**先**加：

```ts
export function buildDefaultIgnore(rootDir: string): Ignore {
  const ig = ignore().add(DEFAULT_IGNORE_PATTERNS);
  // Lower precedence first: git's non-.gitignore exclude sources.
  const extra = readGitExcludeExtraPatterns(rootDir);
  if (extra) ig.add(extra);
  // Highest precedence last: the project .gitignore, so its `!` overrides both
  // a built-in default and anything the exclude sources said.
  const rootGitignore = path.join(rootDir, '.gitignore');
  if (fs.existsSync(rootGitignore)) ig.add(readGitignorePatterns(rootGitignore));
  return ig;
}
```

最终优先级（低 → 高）：内置默认 → `info/exclude` → `core.excludesFile` → `.gitignore`，与 git 一致。

### 3.5 边界

- **非 git 项目**：`resolveGitDir` 返回 null，`core.excludesFile` 查询失败 → 空字符串，行为与今天完全一致。
- **git 未安装 / 超时**：`execFileSync` 抛错被吞，5 秒超时防止卡住。
- **`defaultsOnlyIgnore()`**（嵌入子仓库用）**不合并**额外来源——子仓库自己的 `git ls-files` 已按其自身规则过滤（#514 的既有约束）。

## 4. 行为矩阵

| 场景 | 改动前 | 改动后 |
| --- | --- | --- |
| `.git/info/exclude` 排除 `generated/` | 索引 `generated/*`（**错**） | 不索引，与 `git check-ignore` 一致 |
| `core.excludesFile` 排除 `.DS_Store` 等 | 索引（**错**） | 不索引 |
| `.gitignore` 里 lone `!` 一行 | **整树规则失效**，`node_modules` 被索引 | 该行被忽略，其余规则正常 |
| `.gitignore` 的 `!vendor/` 覆盖内置默认 | 生效 | 仍生效（优先级保持） |
| `.gitignore` 的 `!` 覆盖 `info/exclude` | 不适用（读不到） | 生效（与 git 一致） |
| 非 git 项目 | 只用内置 + `.gitignore` | 不变 |
| 嵌入子仓库（`defaultsOnlyIgnore`） | 只用内置 | 不变 |
| git 命令超时/失败 | — | 静默跳过，索引继续 |

## 5. 验收

- [x] Spec 落盘
- [x] `src/extraction/default-ignore.ts`：`dropEmptyPatterns`（lone `!` / 空模式）；`resolveGitDir`；`readGitExcludeExtraPatterns`；`buildDefaultIgnore` 合并
- [x] 单元测试 `test/gitignore-sources.test.ts`（13 passed，含负向对照）：`info/exclude` 生效；`core.excludesFile` 生效；lone `!` 不反转；三种来源的优先级与 `git check-ignore` 一致；非 git 项目不受影响；嵌入子仓库不吃父级额外来源
- [x] 与 `git check-ignore` 的**对照测试**（同仓库逐路径比对）（同一临时仓库，逐个路径比对）
- [x] `npm run build` 通过
- [x] `npx vitest run test/gitignore-sources.test.ts` 全绿
- [x] 手工验证三个真实场景（info/exclude、core.excludesFile、lone `!` 均修复；`/lib/` 锚定场景零回归）
- [x] CHANGELOG.md `[Unreleased]` Fixes 条目
