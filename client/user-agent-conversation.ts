import type { AgentRunActivity } from "../lib/site-knowledge/protocol";

export type ConversationMessage = {
  id: string;
  kind: "user" | "assistant" | "error" | "system";
  text: string;
  taskId?: string;
};

/** A resumed run carries a suffix of the chat, not authority to erase older turns. */
export function mergeResumedConversation<T extends ConversationMessage>(local: T[], incoming: T[]): T[] {
  if (!incoming.length) return local;
  const same = (a: T, b: T) => a.kind === b.kind && a.text === b.text && (!a.taskId || !b.taskId || a.taskId === b.taskId);
  // Already-present server history can enrich identities without duplicating it.
  for (let start = local.length - incoming.length; start >= 0; start--) {
    if (incoming.every((message, index) => same(local[start + index], message))) {
      return local.map((message, index) => index >= start && index < start + incoming.length
        ? { ...incoming[index - start], ...message, taskId: message.taskId || incoming[index - start].taskId }
        : message);
    }
  }
  for (let overlap = Math.min(local.length, incoming.length); overlap > 0; overlap--) {
    if (incoming.slice(0, overlap).every((message, index) => same(local[local.length - overlap + index], message))) {
      return [...local.slice(0, -overlap), ...incoming.slice(0, overlap).map((message, index) => ({
        ...message, ...local[local.length - overlap + index], taskId: local[local.length - overlap + index].taskId || message.taskId,
      })), ...incoming.slice(overlap)];
    }
  }
  return [...local, ...incoming];
}

/** Tool history belongs to a run, never to whichever user message is last. */
export function activitiesForTurn(activities: AgentRunActivity[], taskId?: string) {
  if (!taskId) return [];
  const seen = new Set<string>();
  return activities.filter((item) => {
    if (item.sessionId !== taskId || item.kind === "reasoning" || item.kind === "result") return false;
    const key = item.kind === "transition" ? `${item.sessionId}:${item.pageEpoch}:${item.url}` : item.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function activitySummaryState(items: AgentRunActivity[]) {
  return items.some(item => item.state === "running") ? "running"
    : items.some(item => item.state === "failed") ? "failed" : "completed";
}
