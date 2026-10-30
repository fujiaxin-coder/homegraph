# 0064 — ViewTree / RTA 懒建方法节点挂声明文件（反 `%AM` file_path 漂移）

| 字段 | 内容 |
| --- | --- |
| 编号 | 0064 |
| 类型 | 修复 |
| 状态 | 已完成 |
| 日期 | 2026-10-30 |
| 范围 | `ArkTSAdapter.ensureMethodNode`（与 `resolveMethodNodeId` 对齐）；ViewTree 回调/Builder 懒建；P3 回归测 `viewtree-am-declaring-file` |
| 非本 Spec | arkui-child kind 扫描（0063）；孤儿 `.ets` TS WASM（0062）；主扫描是否索引 `%AM*`（仍 skip，仅懒建） |

---

## 1. 背景与目标

主扫描 `shouldSkipArkMethod` 跳过匿名 `%AM*`。ViewTree 在 **importer**（如 `AaaHost.ets`）上 `walkViewTree` 进入子组件树时，对子组件上的 `.onClick` / `.onAreaChange` 等调用：

`ensureMethodNode(handler, relativePath=importer, parentId=importerClass)`。

`indexMethod` 用传入的 `relativePath` 写 `file_path` / `contains`，**不用** `method.getDeclaringArkFile()`。谁先跑 ViewTree，谁把匿名方法「抢走」——行号仍对，文件落到 importer（SceneBoard：`ImmersiveKeyguardView` 的 AM 挂到 `MainPageView` / `SCBScreenLock`）。RTA 路径的 `resolveMethodNodeId` 已正确走 declaring file。

**目标：** ViewTree / RTA 懒建的方法节点（含匿名）一律挂在 declaring file；`contains` parent 挂声明 class（或 default-class 时的声明文件），不挂 ViewTree owner。

---

## 2. 范围

### 2.1 做

- `ensureMethodNode` 归因与 `resolveMethodNodeId` 一致：`relativePath` ← declaring ArkFile；`parentId` ← `resolveMethodParentId`；节点写入该文件的 `fileResults`（必要时 `ensureFileResult`）。
- 调用方仍可传 importer 的 path/result/parent（ViewTree 边的 `registeredAt` / caller 仍用 importer）；**节点归属忽略这些参数**。
- 回归：`AaaHost`（字典序先于 `DeclPane`）嵌入 `DeclPane`；`DeclPane` 上 `.onAreaChange(() => …)` 的 `%AM`：
  - `file_path` 以 `DeclPane.ets` 结尾；
  - `contains` 父为 `DeclPane`（非 `AaaHost`）。
- 补充：双 importer 先后嵌入同一 Decl；Page 嵌套走到的 AM 与 Child 本文件 ViewTree 为同一 node id。

### 2.2 不做

- 不改 ViewTree **边** 的 `registeredAt`（仍记 importer 绑定点）。
- 不在主扫描中改为索引全部 `%AM*`（仍懒建）。
- 不改 arkui-child 文本合成。

---

## 3. 行为

| 场景 | 结果 |
| --- | --- |
| ViewTree 在 Host 上嵌套走到 Decl 的 onClick/onAreaChange AM | AM.`file_path` = Decl 相对路径；contains → Decl class |
| Decl 自己的 ViewTree 稍后运行 | `methodToId` / bySig 命中同一节点，不新建、不改挂到 Host |
| RTA 懒建匿名方法 | 与上相同（已走 `resolveMethodNodeId`） |
| 方法 declaring file 不在 scanned / 非 Ark 源 | 不建节点（`null`） |

---

## 4. 验收

- [x] Spec 落盘；`ensureMethodNode` 与 `resolveMethodNodeId` 归因一致
- [x] `viewtree-am-declaring-file` 测例通过（非 skip），含 contains + 双 importer / 同 id 约束
- [x] CHANGELOG `[Unreleased]` 有条目
