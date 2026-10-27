// ── AskUserQuestion 在挂件内的应答载荷 ──
//
// 为什么单独抽成纯函数：这条载荷跨窗口传递（挂件是 leaf 窗，没有后端 WS，
// 经 DataBus 回主窗执行），三个字段任何一个写错，表现都是"点了没反应"或
// "AI 收到空答案"，而两窗之间没有类型检查 —— 只有单测能锁住。
//
//   · `requestId` 丢了 → 主窗的一次性校验（crossWindowBusHub）丢弃迟到响应
//   · `updatedInput` 没合并 `tool_input` → 后端拿不到 questions 之外的字段
//   · `answers` 的 key 必须是 question 原文（后端按它匹配）

/** `cmd.respondPermission` 的载荷形状（与 crossWindowBusHub 的校验一致）。 */
export interface AskQuestionResponsePayload {
  requestId?: string;
  allowed: boolean;
  always: boolean;
  updatedInput?: Record<string, unknown>;
}

/** 待响应的控制请求（只取这里需要的字段）。 */
export interface PendingAskRequest {
  request_id?: string;
  tool_input?: unknown;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** 用户选了答案（或补充了批注）→ 允许执行，并把答案带回后端。 */
export function buildAskAnswerPayload(
  request: PendingAskRequest | null | undefined,
  answers: Record<string, string>,
  annotations: Record<string, { notes?: string }>,
): AskQuestionResponsePayload {
  return {
    requestId: request?.request_id,
    allowed: true,
    always: false,
    // 必须展开原 tool_input：工具参数里除 questions 外还可能有别的字段，
    // 只发 answers 会让后端收到一个"缺字段"的 tool_input。
    updatedInput: { ...asRecord(request?.tool_input), answers, annotations },
  };
}

/** 用户跳过/拒绝（Esc、点跳过）→ 拒绝该工具调用，AI 会收到"用户未回答"。 */
export function buildAskSkipPayload(
  request: PendingAskRequest | null | undefined,
): AskQuestionResponsePayload {
  return { requestId: request?.request_id, allowed: false, always: false };
}
