import type { Locale } from "../i18n";

const zh = {
  search: "搜索用户目标", status: "结果状态", all: "全部结果", cancelled: "已取消",
  count: (n: number) => `${n} 条会话`, listError: "会话记录暂时无法读取，请重试。", detailError: "这条会话的详情暂时无法读取，请重试。",
  retry: "重新加载", reset: "清除筛选", noMatch: "没有匹配的会话", noMatchHint: "调整搜索或筛选条件后再试。", empty: "暂无会话", emptyHint: "用户开始使用智能体后，会话会出现在这里。",
  loading: "正在读取会话", updating: "正在更新结果…", loadingDetail: "正在读取详情", unnamed: "未命名任务", noSummary: "没有结果摘要", more: "加载更多", loadingMore: "正在加载…",
  pick: "选择一条会话", goal: "任务目标", conversation: "对话", activity: "操作过程", user: "用户", agent: "智能体", noConversation: "没有可展示的对话", noConversationHint: "这条旧记录只保留了任务结果。",
  replay: "页面回放", keyActions: "关键操作", noReplay: "没有页面回放", noReplayHint: "这条记录仍保留了任务结果，但当时没有采集到页面操作过程。",
};
const en: typeof zh = {
  search: "Search user goals", status: "Outcome", all: "All outcomes", cancelled: "Cancelled",
  count: n => `${n} sessions`, listError: "Could not load sessions. Please retry.", detailError: "Could not load this session. Please retry.",
  retry: "Retry", reset: "Clear filters", noMatch: "No matching sessions", noMatchHint: "Try another search or outcome filter.", empty: "No sessions yet", emptyHint: "Sessions appear here when users start using the agent.",
  loading: "Loading sessions", updating: "Updating results…", loadingDetail: "Loading details", unnamed: "Untitled task", noSummary: "No outcome summary", more: "Load more", loadingMore: "Loading…",
  pick: "Select a session", goal: "Task goal", conversation: "Conversation", activity: "Activity", user: "User", agent: "Agent", noConversation: "No conversation available", noConversationHint: "This older record only contains the task outcome.",
  replay: "Page replay", keyActions: "Key actions", noReplay: "No page replay", noReplayHint: "The task outcome is retained, but page activity was not captured at the time.",
};
export function sessionCopy(locale: Locale) { return locale === "en" ? en : zh; }
