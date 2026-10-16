# 0054 — C++/NAPI：头文件语言、宏可见性、include 遍历上界


| 字段 | 内容 |
| --- | --- |
| 编号 | 0054 |
| 类型 | 变更 |
| 状态 | 已完成 |
| 日期 | 2026-10-16 |
| 范围 | `.h` 的 C/C++ 判定；C/C++ 调用在解析前的宏可见性；include 图遍历上界 |
| 关联 | [codegraph `cpp-macro-visibility`](https://github.com/colbymchenry/codegraph/commits/main/)（`#2127` include 爆炸、`#1838` 宏被当成函数调用）；鸿蒙 native / NAPI 与 ArkAnalyzer 的 `.ets` 无关 |
| 非本 Spec | 重载按实参挑选、`nullptr` / 已删除重载、特化与嵌套类名字、`->` / 下标 / `front()` 等到元素类型、宏展开方法铸节点、`#ifdef` 让位给参与编译的 `.c`、超深嵌套段错误、sync 栈溢出、函数指针正则缓存。这些在 codegraph 的 `name-matcher`（约 900KB，与本仓不是同一份）里，不能整文件搬 |


---

## 1. 背景与目标

鸿蒙 native / NAPI 仍走本仓的 C/C++ 提取和解析。两类问题可以单独修，不改 ArkTS：

1. 只有 `struct Derived : Base` 的头文件被 `looksLikeCpp` 当成 C（原先只认 `class`，不认继承形式的 `struct`）。
2. `#define X_H 1` 这种认不出的 include guard，会让每个 include 路径重扫头文件。层状 include 图是指数级扫描，Resolving 阶段会把堆打满。同时，调用点上可见的函数式宏（`TRACE(1)`）不该连到别的文件里同名函数。

**目标：**

1. 带基类的 `struct` / `class` 头文件判定为 C++。普通 C `struct Point { ... }` 仍是 C。
2. 解析 C/C++ `calls` 之前，若该名字在调用点是可见的函数式宏，则不建边。
3. 同一头文件在「这次进入没有改变可见宏」时不再重入；走不完时有预算，预算之外不抑制调用。

---

## 2. 范围

### 2.1 做

- `looksLikeCpp`：`struct Name :` / `struct Name {` 与 `class` 同样视为 C++。
- 引入 `src/resolution/cpp-macro-visibility.ts`（来自 codegraph，按本仓 `ResolutionContext` / `resolveImportPath` 接入）。
- `resolveOne`：C/C++ 的 `calls` 在 `isVisibleCppMacro` 为真时返回 `null`。
- 清解析缓存时同时 `clearCppMacroVisibility`。
- `maskCppRawStrings`：宏扫描前遮住 C++ raw string，避免把字面量里的内容当成指令。
- 单测：头文件判定；40 层、每层两个头的 include 图在 1 秒内走完。

### 2.2 不做

- 把 codegraph 的 `name-matcher.ts` 覆盖本仓。
- 按实参选重载、接收者类型（`->`、下标、`front`/`back`/`at`、`get`/`value`、迭代器 `second`）。
- 宏调用处补方法节点（`PROTOBUF_DEFINE_ACCESSOR`）。
- `#ifdef` 未定义符号让位给 `.c` 里的定义（`c-feature-variants`）。
- `static` 跨文件、已删除重载、`nullptr_t`、显式特化名字、嵌套类类外定义、`::` 查找。
- 解析器嵌套深度、sync 栈、正则缓存。

这些仍以 codegraph 对应提交为参照，另开改动，不塞进本次。

---

## 3. 行为

| 输入 | 结果 |
| --- | --- |
| `types.h` 内容为 `struct Derived : Base { ... }` | `detectLanguage` → `cpp` |
| `types.h` 内容为 `struct Point { int x; }` | `detectLanguage` → `c` |
| `unit.cpp` include 了 `#define TRACE(v)`，第 4 行调用 `TRACE` | `isVisibleCppMacro` 为 true，`resolveOne` 不连边 |
| include 写在 `TRACE` 调用之后 | 该行不是可见宏 |
| 40 层、每层 a/b 两个头，guard 为 `#define X 1`、空 `#define X` 或未知 `#ifdef` | 遍历在 1 秒内结束 |

---

## 4. 验收标准

- [x] Spec 落盘（本文件）
- [x] `struct Derived : Base` 的 `.h` 判为 C++，普通 C struct 仍为 C
- [x] 40 层 include 图上 `TRACE` 的可见性判定在 1 秒内完成，且 include 之前的行不是宏
- [x] CHANGELOG Unreleased

---

## 5. 风险与回滚

| 风险 | 缓解 |
| --- | --- |
| 把合法的 C 头误判成 C++ | 只加 `struct` + `:` 或 `{`；`struct Point {` 含 `{`，会变成 C++。**见下** |

`struct Name {` 在 C 里合法。把 `{` 也算 C++ 会把普通 C 头判成 C++。实现只把 `struct Name :` 算 C++，`struct Name {` 保持 C。单测锁住这一点。

回滚：去掉 `resolveOne` 里的宏判断，并恢复 `looksLikeCpp` 的正则。
