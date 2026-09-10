# 本分支相对上游的偏离

上游：`github.com/nonewind/dsh-spend`。本文件只记录**与上游同一处代码存在分歧**的地方——下次同步上游时必须逐条决定去留，其余分支新增功能不在此列。

## 1. 客户端 refresh：保留 fork 实现，未采纳上游 0.6.3 的在途守卫

**上游做法**（0.6.3，提交 `eafc616`）：`refresh` 用 `refreshInFlight` ref 挡住并发请求，捕获 `requestedCwd` 后在 `.then` 中比对，工作区在途变更时于 `.finally` 重新发起；`refresh` 不再返回 promise。

**本分支做法**：沿用 0.6.2 之前的实现——`setLoading(true)` 后直接发起查询，**返回该 promise**。

**原因**：合并上游 0.6.3 后线上出现「点击悬浮球后整个组件消失」——容器 `div#dsh-spend-widget` 仍在、内部子树全空，即渲染抛错、React 卸载了根。数据本身正常（药丸上显示 `¥13.33 · 54.72M`），宿主查询 0.2 秒返回完整快照。当日客户端实质只动过两处，refresh 是其中之一，故先退回本实现。

**该假设已被证伪，真实成因已定位**：退回之后（0.6.15 起）同一现象**再次出现**；0.6.19 把边界捕获的错误回传服务端后定位为 §4 所述的上游缺陷，与 refresh 无关。本分支保留 fork 实现的理由只剩下面这条 `return`。下次同步上游时，**可以**重新采纳上游写法，但必须保留返回值。

**顺带**：上游写法丢掉了 `return`，而 `savePricing` / `deletePricing` 依赖 `await refresh()` 才能显示改价后的快照——重新采纳时必须保留返回值。

## 2. 按用户隔离（fork 独有，上游无对应）

`compute()` / `queryForPrincipal()` 接受 principal 与 principalId，快照按调用者过滤后再聚合；缓存键含调用者作用域。客户端 `query` 多传一个账号过滤参数。合并上游对这两个函数的改动时，需要把上游改动**并入**这些参数，而不是替换。

## 3. 会话费用 Remote（fork 独有）

`sessionCost` 与 `costRatesAt` 供 dsh-context 的费用卡取数，见部署手册 §45。上游无此接口，其 Remote 名单只有四项。

`sessionCost` 的返回值除金额外还带**已计费 token 用量**（会话级与每模型各四路：input / output / cacheRead / cacheWrite），因为这些 token 正是金额的计算依据；`reasoningTokens` 不随行，供应商已把它计入 output，再加一次会重复计费。`calls` 保留在线上仅为兼容旧版 dsh-context，新版费用卡不再展示调用次数。

该接口按**会话族**聚合，不是单行：工作流成员、子代理与被续接的会话各自带 `parentSession` 单独记账，只读 `sessionId` 那一行会漏掉整棵树的开销与模型。快照因此新增 `sessionParents`（仅限调用者自己可见的树），聚合走未截断的 `bySessionModel`（`bySession` 受 `maxSessions` 截断），返回值多一个 `sessions` 说明合并了几个会话。

## 6. fork 继承段不重复计费（fork 独有）

`foldSession` 遇到带 `inherited: true` 的 `session/end-seed` 标记就丢弃此前累积的全部样本。seeded 会话的日志开头是它所 fork 自的那个会话的逐字副本，那批调用已在源会话计过费；不切会导致同一次模型调用每被 fork 一次就多计一次。不带该标志的标记是会话给自己的 seed 收尾，不构成切点。切点取最后一个 inherited 标记，与 harness 的 persistence 契约一致（`docs/subsystems/persistence.md`）。

## 7. 悬浮球可拖动（fork 独有）

`useDraggableWidget`：按住药丸拖动，位置存 `localStorage['dsh-spend:position']`（`right`/`bottom` 偏移，与样式表锚点一致），窗口缩放时夹回可视区。位移不足 4px 仍算点击，照常展开面板。上游悬浮球固定在右下角。

## 4. PlansSection 的实时用量行：本分支已修复的上游缺陷

**上游做法**（`e3534f1`，2026-08-25，订阅商实时额度）：code 型计划卡里 `liveBody`（读 `providerUsage.fetchedAt`）与 `liveErrorNote`（读 `providerUsage.error`）在渲染时急切构造，消费处才按 `showLive` / `liveFailed` 门控。

**本分支做法**（0.6.20）：二者只在 `providerUsage` 存在时构造。

**原因**：服务端对没有用量适配器的 provider 不给 `providerUsage`，该行为 `null`；线上 `kimi-coding` 被自动发现为 code 型计划且无适配器，点击展开即抛 `Cannot read properties of null (reading 'fetchedAt')`，React 卸载整个组件。回归测试 `test/widget.test.js` 在上游写法上失败。

**同步注意**：上游若仍是急切构造，合并时保留本分支写法，并考虑把该修复回报上游。

## 5. 渲染失败回传服务端（fork 独有）

0.6.18 的 `WidgetBoundary` 与 0.6.19 的 Remote `usageStats/reportRenderFailure`：边界捕获后把 message / stack / componentStack 写进服务端日志。上游无对应；合并上游对 `apply()` 挂载段或 Remote 名单的改动时须保留。

