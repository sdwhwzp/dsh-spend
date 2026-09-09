# 本分支相对上游的偏离

上游：`github.com/nonewind/dsh-spend`。本文件只记录**与上游同一处代码存在分歧**的地方——下次同步上游时必须逐条决定去留，其余分支新增功能不在此列。

## 1. 客户端 refresh：保留 fork 实现，未采纳上游 0.6.3 的在途守卫

**上游做法**（0.6.3，提交 `eafc616`）：`refresh` 用 `refreshInFlight` ref 挡住并发请求，捕获 `requestedCwd` 后在 `.then` 中比对，工作区在途变更时于 `.finally` 重新发起；`refresh` 不再返回 promise。

**本分支做法**：沿用 0.6.2 之前的实现——`setLoading(true)` 后直接发起查询，**返回该 promise**。

**原因**：2026-09-09 采纳上游写法后，线上出现「点击悬浮球后整个组件消失」：容器 `div#dsh-spend-widget` 仍在、内部子树全空，即 React 根被卸载。数据本身正常（药丸上正常显示 `¥13.33 · 54.72M`），宿主查询 0.2 秒返回完整快照。退回本实现后恢复。

**注意**：该次恢复与一次浏览器强刷同时发生，因此「上游写法是唯一成因」并未被单独证实；也未定位到上游写法中具体哪一步导致抛错。下次同步若要重新采纳，应先在灰度环境单独验证展开路径。

**顺带**：上游写法丢掉了 `return`，而 `savePricing` / `deletePricing` 依赖 `await refresh()` 才能显示改价后的快照——重新采纳时必须保留返回值。

## 2. 按用户隔离（fork 独有，上游无对应）

`compute()` / `queryForPrincipal()` 接受 principal 与 principalId，快照按调用者过滤后再聚合；缓存键含调用者作用域。客户端 `query` 多传一个账号过滤参数。合并上游对这两个函数的改动时，需要把上游改动**并入**这些参数，而不是替换。

## 3. 会话费用 Remote（fork 独有）

`sessionCost` 与 `costRatesAt` 供 dsh-context 的费用卡取数，见部署手册 §45。上游无此接口，其 Remote 名单只有四项。
