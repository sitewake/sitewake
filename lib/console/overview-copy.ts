import type { Locale } from "../i18n";

const zh = {
  startTitle: "让第一个任务真正完成", startBody: "先连接网站，再在真实页面里试一次。结果会回到这里。",
  liveTitle: "用户的任务，完成得怎么样？", liveBody: "从最近的任务结果出发，查看需要处理的问题和可以复用的能力。",
  open: "去网站试一试", install: "接入代码", copy: "复制代码", copied: "已复制", copyFailed: "复制失败，请选中代码手动复制。",
  installHelp: "把这段代码加入网站页面。刷新网站后，SiteWake 会自动检测连接。模型密钥只配置在服务端。",
  steps: ["连接网站", "完成首个任务", "复用已学能力"],
  nextConnect: "下一步：添加接入代码，然后打开网站。", nextTask: "下一步：在网站右下角的助手中提出一个具体目标。", nextLearn: "已有成功任务。能力通过验证后，才能用于后续任务。", nextReady: "已有可用能力。继续关注真实任务的结果。",
  modelMissing: "尚未配置模型。请在服务端配置模型后再试任务；本地开发可运行 npm run setup。",
  sample: "最近任务样本", success: "已完成", faults: "执行异常", unknown: "结果待确认", available: "可用业务能力", sampleNote: "仅统计接口返回的最近任务，不代表全量或今日成功率。",
  preview: "网站预览", generate: "生成截图", generating: "生成中…", refresh: "刷新", notGenerated: "尚未生成", captured: "已捕获", noPreview: "尚无截图", previewHint: "截图用于检查页面外观；连接状态以 SDK 上报为准。",
  keeping: "正在刷新，当前继续显示上一张", detected: "已检测到智能体入口", notDetected: "未检测到智能体入口", refreshFailed: "本次刷新失败，已保留上一张截图", previewFailed: "截图生成失败，请稍后重试", previewStartFailed: "截图任务暂时无法启动，请稍后重试。", pollFailed: "暂时无法读取截图进度，正在重试。",
  agent: "智能体", edit: "编辑", position: "入口位置", left: "左下角", right: "右下角", suggestions: "推荐问题", show: "显示", hide: "隐藏", knowledge: "网站知识", view: "查看", pages: "类页面",
  sessions: "最近会话", all: "查看全部", noSessions: "等待第一个任务", sessionsHint: "打开网站，在助手里说出目标。完成后在这里检查结果。",
  capabilities: "可复用的能力", noCapabilities: "尚无可用能力", capabilitiesHint: "能力需要经过验证。一次成功不会自动等于稳定可用。", noDescription: "暂无说明", ready: "可用", improving: "完善中",
  status: { success: "已完成", "no-result": "无结果", "business-rejection": "业务未通过", "execution-fault": "执行异常", unknown: "结果待确认" },
};
const en: typeof zh = {
  startTitle: "Complete the first real task", startBody: "Connect your site, then try a task on the actual page. Its result will appear here.",
  liveTitle: "Are users getting things done?", liveBody: "Start with recent outcomes, investigate problems, and see which capabilities are ready to reuse.",
  open: "Try on your site", install: "Installation code", copy: "Copy code", copied: "Copied", copyFailed: "Could not copy. Select the code and copy it manually.",
  installHelp: "Add this code to your pages, then refresh your site to report the connection. Configure model keys only on the server.",
  steps: ["Connect your site", "Complete a task", "Reuse a capability"],
  nextConnect: "Next: add the installation code, then open your site.", nextTask: "Next: give the assistant on your site a specific goal.", nextLearn: "A task succeeded. Capabilities must pass validation before reuse.", nextReady: "Capabilities are available. Keep checking real task outcomes.",
  modelMissing: "No model configured. Configure a model on the server before trying a task; for local development, run npm run setup.",
  sample: "Recent task sample", success: "Completed", faults: "Execution errors", unknown: "Unconfirmed outcomes", available: "Available capabilities", sampleNote: "Counts cover only the recent tasks returned by the API, not all-time or daily success rates.",
  preview: "Site preview", generate: "Generate screenshot", generating: "Generating…", refresh: "Refresh", notGenerated: "Not generated", captured: "Captured", noPreview: "No screenshot yet", previewHint: "Screenshots check appearance; SDK reports determine connection status.",
  keeping: "Refreshing; the previous screenshot stays visible", detected: "Agent entry detected", notDetected: "Agent entry not detected", refreshFailed: "Refresh failed; the previous screenshot is retained", previewFailed: "Screenshot failed. Please retry.", previewStartFailed: "Could not start a screenshot. Please retry.", pollFailed: "Could not read screenshot progress. Retrying…",
  agent: "Agent", edit: "Edit", position: "Launcher position", left: "Bottom left", right: "Bottom right", suggestions: "Suggestions", show: "Visible", hide: "Hidden", knowledge: "Site knowledge", view: "View", pages: "page types",
  sessions: "Recent sessions", all: "View all", noSessions: "Waiting for the first task", sessionsHint: "Open your site and give the assistant a goal. Check the outcome here afterwards.",
  capabilities: "Reusable capabilities", noCapabilities: "No capabilities available yet", capabilitiesHint: "Capabilities need validation. One successful task does not yet prove reliable reuse.", noDescription: "No description", ready: "Available", improving: "Improving",
  status: { success: "Completed", "no-result": "No result", "business-rejection": "Business rejection", "execution-fault": "Execution error", unknown: "Unconfirmed" },
};
export function overviewCopy(locale: Locale) { return locale === "en" ? en : zh; }
