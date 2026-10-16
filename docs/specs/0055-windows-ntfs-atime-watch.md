# 0055 — Windows：NTFS 访问时间不触发待同步


| 字段 | 内容 |
| --- | --- |
| 编号 | 0055 |
| 类型 | 变更 |
| 状态 | 已完成 |
| 日期 | 2026-10-16 |
| 范围 | Windows 文件监视器；MCP 回复里的「文件已改、待同步」 |
| 关联 | [codegraph#1451](https://github.com/colbymchenry/codegraph/issues/1451)（PR #1472） |
| 非本 Spec | 库被占用时 `index` 的可重试结果；工作线程未启动完就退出的 3221225477 |


---

## 1. 背景与目标

Windows 的 NTFS 若开着「记录访问时间」，只读一个文件也会改 `LastAccessTime`。`fs.watch` 走 `ReadDirectoryChangesW`，会把这次访问报成和保存一样的 `change`。监视器收到事件就写入 `pendingFiles` 并安排同步。

`explore` 为了拼答案会去读源文件。读完后，这些文件出现在回复开头的「已修改、待同步」里。磁盘上的大小和修改时间都没变，git 也是干净的。macOS 的 FSEvents 和 Linux 的 inotify 不报「读」，所以只有 Windows 会这样。随后的同步本身是空操作（大小和 mtime 已经对得上），伤害在那条假的过期提示。

**目标：** Windows 上，已经进索引的文件如果大小和修改时间仍与库中记录一致，这次监视事件不进入待同步，也不安排同步。真正的写入、删除、以及库里还没有的新文件照旧处理。

---

## 2. 范围

### 2.1 做

- `FileWatcher` 增加 `indexedFingerprint`：按相对路径取索引里的 `size` 和 `modifiedAt`。`HomeGraph.watch` 接到 `getFile`。
- 仅 `win32`：事件对应的文件仍在磁盘上，且大小、`mtime`（毫秒取整）与索引一致时，丢掉该事件。
- 查不到索引、`stat` 失败、或回调查询抛错：保留事件（删除、新文件、查库失败都不能漏）。
- 单测锁住：访问时间变化被丢掉；内容改了仍进入待同步；未索引和已删除的文件仍进入待同步。

### 2.2 不做

- 不改 macOS / Linux 的监视路径。
- 不改同步阶段已有的「大小 + mtime 相同则跳过」预过滤。
- 库被占用时的 `index`，以及退出码 3221225477。

---

## 3. 行为

| 情况 | 结果 |
| --- | --- |
| Windows，文件已索引，磁盘大小和 mtime 与索引相同（只改了 atime） | 不进入 `pendingFiles`，不调用 sync |
| Windows，mtime 或大小与索引不同 | 进入待同步 |
| Windows，索引里没有这个路径 | 进入待同步 |
| Windows，文件已从磁盘删除 | 进入待同步 |
| 非 Windows | 不因大小和 mtime 相同而丢事件 |

大小和 mtime 都没变、内容却变了，仍是 mtime 增量的盲区，和现有 sync 预过滤相同。`homegraph index --force` 仍是出口。

---

## 4. 验收标准

- [x] Spec 落盘（本文件）
- [x] `isAccessTimeOnlyChange` 只在 Windows 且大小、mtime 都一致时为真
- [x] Windows 上监视器丢掉仅访问时间变化的事件，保留真实修改、新文件和删除
- [x] CHANGELOG Unreleased

---

## 5. 风险与回滚

| 风险 | 缓解 |
| --- | --- |
| 每次 Windows 事件多一次 `stat` 和一次按路径查库 | 只在已提供 `indexedFingerprint` 的 Windows 路径上做；查失败则当真实变更 |
| 把真实修改当成访问时间 | 只在大小和取整后的 mtime 都相等时丢弃 |

回滚：去掉 `handleChange` 里的 `isAccessTimeOnly` 判断，以及 `watch()` 传入的 `indexedFingerprint`。
