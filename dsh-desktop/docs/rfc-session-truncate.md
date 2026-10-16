# RFC: 会话原地截断能力（session.truncate）

## 1. 背景与动机

### 1.1 问题现状

DSH 内核当前**没有原地截断会话的能力**。撤回/编辑重发等场景只能走 `session.fork(atSeq)`：

- fork 必然产生**新的 sessionId**，原会话保留在磁盘和索引中；
- 若原会话仍在 running / active-turn 状态，内核拒绝 `deleteSession` 与 `archiveSession`；
- 结果：用户看到"撤回后多出一个同名会话"，或撤回失败。

现有补救（v1.0.6 easyrewrite A+C）：先 cancel 回合 → 重试删除 → 双失败时回滚副本。这是**治标**——避免了最糟的观感，但没有实现真正的原地截断。

### 1.2 为什么需要原地截断

| 场景 | fork 的问题 | truncate 的优势 |
| --- | --- | --- |
| 撤回消息 | 新 sessionId，标题继承但 ID 变了，历史记录断裂 | 同一 sessionId，仅丢弃指定序列号之后的内容 |
| 编辑重发 | 同上 | 同上 |
| 清理误发送 | 必须 fork + 手动删原会话（running 时不可删） | 原子截断，无需删除原会话 |
| 合规/隐私擦除 | fork 后原会话仍完整存在于磁盘 | 原位置直接覆盖/截断，无残留 |

**核心诉求**：用户期望"撤回 = 这条消息及之后从未发生过"，而非"新建一个看起来一样的会话"。

---

## 2. 提案概述

在内核新增 **`session.truncate(sessionId, atSeq)`** RPC 方法：

- **语义**：保留 `[0..atSeq]`（含）的消息与元数据，丢弃 `(atSeq, end]` 的所有内容；
- **原子性**：单次操作完成消息截断、header 更新、synapse 索引同步、attachment 引用计数调整；
- **权限**：允许对 running / active-turn 会话执行（截断本身即隐含 stop）；
- **幂等**：重复调用同一 `(sessionId, atSeq)` 为 no-op。

---

## 3. 设计细节

### 3.1 API 契约

```typescript
// @deepseek-ai/dsh-api-session-controller
interface SessionController {
  /**
   * 原地截断会话：保留 [0..atSeq] 的消息，丢弃后续内容。
   * @param sessionId - 目标会话 ID
   * @param atSeq     - 截断边界（含），必须 ≤ 当前 lastTurnEndSeq
   * @returns { ok: true, truncatedCount: number }
   * @throws SessionNotFoundError       - sessionId 不存在
   * @throws InvalidTruncateBoundaryError - atSeq > lastTurnEndSeq 或 atSeq < 0
   */
  truncate(sessionId: string, atSeq: number): Promise<{
    ok: boolean;
    truncatedCount: number;  // 被丢弃的消息条数
  }>;
}
```

**错误码扩展**（`dsh-tauri/contracts/error-codes.md`）：

| code | 说明 |
| --- | --- |
| `session/truncate-invalid-boundary` | atSeq 超出合法范围 |
| `session/truncate-failed` | 截断过程中发生不可恢复错误（IO / 索引损坏） |

### 3.2 存储层实现要点

以 `@deepseek-ai/dsh-session-persistence` 为例：

```
truncate(sessionId, atSeq):
  1. 读取 session header，校验 atSeq ≤ header.lastTurnEndSeq
  2. 计算需丢弃的消息数：truncatedCount = header.messageCount - (atSeq + 1)
  3. 截断消息文件（append-only log 则写入 EOF marker；可写文件则 truncate 到 offset）
  4. 更新 header：
       messageCount = atSeq + 1
       lastTurnEndSeq = atSeq（若 atSeq 落在某 turn 中间，需回退到该 turn 起始 seq）
       updatedAt = now
  5. 同步 synapse 索引：移除 (atSeq, end] 对应的索引条目
  6. 调整 attachment 引用计数：递减被丢弃消息引用的附件计数，零引用则标记可回收
  7. 若会话处于 running 状态，隐式执行 stop（cancel 当前 turn）
  8. 返回 { ok: true, truncatedCount }
```

**关键约束**：
- `atSeq` 必须对齐到 **turn 边界**（不能截断到某 turn 中间），否则对话历史语义不完整；
- 截断后**不释放磁盘空间**（append-only 日志的特性），但逻辑上已不可见；如需物理回收，由后台 compact 任务处理；
- 截断操作**不可逆**（无 undo）。

### 3.3 与现有能力的关系

| 现有方法 | 与 truncate 的关系 |
| --- | --- |
| `fork(sessionId, atSeq)` | fork 是"复制前缀到新会话"；truncate 是"原地丢弃后缀"。两者互补，不应互相替代 |
| `deleteSession(sessionId)` | delete 是整体会话移除；truncate 是部分内容移除 |
| `archiveSession(sessionId)` | archive 是软删除（隐藏）；truncate 是内容裁剪 |
| `stop(sessionId)` | truncate 对 running 会话隐式 stop，无需调用方手动 stop |

### 3.4 安全与权限

- truncate 属于**写操作**，需通过 DSH permission preset 鉴权（默认 `workspace-write`）；
- 截断后的会话**仍可被 read / fork / delete**，行为与正常会话一致；
- 审计日志记录 truncate 操作（sessionId, atSeq, truncatedCount, operator, timestamp）。

---

## 4. 调用方适配（easyrewrite 撤回路径）

```typescript
// dsh-easyrewrite/lib/client.js — recall 路径
async function recallMessage(props, sid, boundary) {
  // 1. 尝试原地截断（新能力）
  try {
    const result = await props.ctxSessions.truncate(sid, boundary);
    log("info", "recall", "原地截断成功", { sessionId: sid, atSeq: boundary, truncated: result.truncatedCount });
    // 截断后会话仍在原地，无需切换会话
    return { success: true, newSessionId: null };
  } catch (e) {
    // 2. 降级：fork + 接管（兼容旧内核）
    log("warn", "recall", "truncate 不可用，降级为 fork", { err: String(e) });
    const newId = await props.ctxSessions.fork({ sessionId: sid, atSeq: boundary });
    await takeoverOldSessionWithStop(props, sid, "recall");
    safeOpenSession(newId, props);
    return { success: true, newSessionId: newId };
  }
}
```

**优势**：
- 新内核下：真正原地截断，无新 sessionId，用户体验完美；
- 旧内核下：自动降级为 fork + 接管，向后兼容；
- 不再需要"回滚副本"的兜底逻辑（truncate 对 running 会话也可执行）。

---

## 5. 测试计划

### 5.1 单元测试

| 用例 | 预期 |
| --- | --- |
| truncate 正常会话（atSeq = lastTurnEndSeq） | 截断 0 条，header 不变 |
| truncate 正常会话（atSeq < lastTurnEndSeq） | 丢弃正确数量的消息，header 更新 |
| truncate running 会话 | 隐式 stop + 截断成功 |
| truncate atSeq > lastTurnEndSeq | 抛 InvalidTruncateBoundaryError |
| truncate atSeq 落在 turn 中间 | 自动回退到 turn 起始 seq |
| truncate 不存在的 sessionId | 抛 SessionNotFoundError |
| 重复 truncate 同一 (sessionId, atSeq) | no-op，truncatedCount = 0 |
| truncate 后 fork | fork 出的会话包含截断后的完整前缀 |
| truncate 后 delete | 正常删除，无残留 |

### 5.2 集成测试

- easyrewrite 撤回路径：新内核下 truncate 生效，旧内核下降级 fork；
- synapse 索引一致性：truncate 后搜索不包含被丢弃的消息；
- attachment 引用计数：被丢弃消息引用的附件计数正确递减。

---

## 6. 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| truncate 破坏 append-only 日志的完整性 | 使用 EOF marker 而非物理截断；compact 任务负责物理回收 |
| atSeq 不对齐 turn 边界导致语义混乱 | 实现层自动回退到 turn 起始 seq，并在返回值中告知实际截断点 |
| 并发 truncate + write 导致数据竞争 | truncate 获取会话写锁，与 write 互斥 |
| 旧客户端调用 truncate 报错 | 服务端返回 `method-not-found`，客户端自动降级为 fork |

---

## 7. 实施路线图

| 阶段 | 内容 | 预估工时 |
| --- | --- | --- |
| 1. 契约定义 | error-codes.md + bridge-api.md 新增 truncate 条目 | 0.5d |
| 2. 存储层实现 | dsh-session-persistence 实现 truncate 逻辑 | 2d |
| 3. API 层接线 | dsh-api-session-controller 暴露 truncate RPC | 0.5d |
| 4. 测试 | 单元测试 + 集成测试 | 1d |
| 5. 调用方适配 | easyrewrite 撤回路径改用 truncate + 降级 | 0.5d |
| 6. 文档 | plugin-contract.md / development.md 更新 | 0.5d |
| **合计** | | **~5d** |

---

## 8. 参考

- 当前 easyrewrite 撤回实现：`dsh-desktop/assets/plugins/dsh-easyrewrite/lib/client.js` L2526-L2640（takeoverOldSessionWithStop + rollbackForkedClone）
- 内核 fork 实现：`@deepseek-ai/dsh-api-session-controller/lib/client.js` L2876-L2900
- 会话持久化层：`@deepseek-ai/dsh-session-persistence/lib/session-store.js`
