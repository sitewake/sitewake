/**
 * The on-page widget's own copy catalog and locale resolution.
 *
 * Deliberately separate from `lib/i18n`, which the console uses. Two reasons:
 *
 *  - **Different bundle.** The widget ships as one injected file to every
 *    visitor of a customer's site. Importing the console catalog would drag
 *    ~3,600 lines of operator-facing copy into it for no benefit.
 *  - **Different audience, so a different mechanism.** The console's reader is
 *    the site operator — one person whose choice lives in a cookie on our
 *    domain, read by our server before it renders. The widget's readers are the
 *    customer's visitors — many people, each with their own language, on
 *    someone else's origin where our cookie is unreadable and the `<html lang>`
 *    belongs to the customer's site, not to us.
 *
 * So the widget follows the visitor: their own saved choice first, then what
 * their browser asks for. It is stored in `localStorage`, which is right here
 * for a reason it was not right for the console — the widget renders entirely
 * in the browser, so nothing needs to know the language before the first byte,
 * and per-origin isolation is exactly what we want: a choice made on one
 * customer's site must not leak to another's.
 */

export type WidgetLocale = "zh" | "en";

export const WIDGET_LOCALE_KEY = "sitewake:locale";

const DEFAULT_LOCALE: WidgetLocale = "zh";

export function isWidgetLocale(value: unknown): value is WidgetLocale {
  return value === "zh" || value === "en";
}

/** The first supported language in an ordered list of BCP-47 tags. */
function firstSupported(tags: readonly string[]): WidgetLocale | undefined {
  for (const tag of tags) {
    const base = String(tag || "").toLowerCase().trim().split(/[-_]/)[0];
    if (base === "zh" || base === "en") return base;
  }
  return undefined;
}

/**
 * The language this visitor should see.
 *
 * Their explicit choice outranks the browser because it is the newer and more
 * specific signal — someone who switched to English on a Chinese-locale machine
 * meant it. `navigator.languages` is preferred over `navigator.language`: it is
 * the full ordered preference list, so a visitor whose first language we do not
 * support can still be served their second.
 */
export function resolveWidgetLocale(): WidgetLocale {
  try {
    const saved = localStorage.getItem(WIDGET_LOCALE_KEY);
    if (isWidgetLocale(saved)) return saved;
  } catch {
    // Private mode, blocked storage, sandboxed iframe: fall through to the browser.
  }
  const navigatorLanguages = typeof navigator === "undefined"
    ? []
    : navigator.languages?.length ? navigator.languages : [navigator.language];
  return firstSupported(navigatorLanguages) ?? DEFAULT_LOCALE;
}

/**
 * Remember a choice. The caller re-renders; there is no reload, because unlike
 * the console nothing here was rendered on a server.
 */
export function saveWidgetLocale(locale: WidgetLocale) {
  try {
    localStorage.setItem(WIDGET_LOCALE_KEY, locale);
  } catch {
    // Storage refused. The choice still applies to this page view.
  }
}

/**
 * The language instruction appended to the system prompt.
 *
 * A translated widget shell with replies still in Chinese is the real half-finished
 * job — buttons and placeholders are just the frame; what the visitor reads is what
 * the agent says. The page's language does not matter: the model can read a Chinese
 * page and answer in English, which is exactly what it is asked to do.
 */
export function replyLanguageInstruction(locale: WidgetLocale) {
  return locale === "en"
    ? "Always reply to the user in English, even when the page content, the site knowledge and these instructions are in another language."
    : "始终用中文回答用户，即使页面内容或这些指令是别的语言。";
}

// i18n-exempt: language names must always show in their own language — translated they become unrecognizable
export const WIDGET_LOCALE_LABELS: Record<WidgetLocale, string> = { zh: "中文", en: "English" };

const zh = {
  launcher: {
    open: "打开网站助手",
    prompt: "告诉 SiteWake 你想做什么",
  },
  panel: {
    label: "网站助手",
    agentName: "网站助手",
    newChat: "开始新对话",
    close: "关闭",
    language: "语言",
    runTrace: "任务执行记录",
  },
  empty: {
    title: "今天想在这个网站完成什么？",
    body: "直接说出目标，我会操作当前页面，并在完成后把结果告诉你。",
  },
  teach: {
    bannerTitle: "我正在学习你的操作",
    bannerBody: "请在页面中完成目标，结束后点击右侧按钮。",
    finish: "我完成了",
    finishDemo: "完成演示",
    preparing: "正在准备演示…",
    awaitingAction: "等待页面操作",
    goalFallback: "演示网站操作",
    steps: (count: number) => `${count} 个步骤`,
    recording: "正在记录页面操作",
    prompt: (goal: string) => `请直接在页面中完成“${goal}”。完成后回到这里点击“我完成了”。`,
    cancelled: "已取消这次演示，没有生成能力证据。",
  },
  composer: {
    placeholder: "给 SiteWake 一个目标…",
    send: "发送",
    stop: "停止任务",
    poweredBy: "由 SiteWake 提供",
    modeHint: "由 SiteWake 提供 · 当前页面执行",
    teachIntentHint: "先告诉我这次演示想完成什么",
    teachingHint: "请操作网站，完成后点击“我完成了”",
    busyHint: "正在当前页面为你处理",
    teachIntentPlaceholder: "这次操作要完成什么？",
  },
  status: {
    connecting: "正在连接…",
    connected: "已连接，可以开始",
    answering: "正在回答",
    generating: "正在生成回答",
    failed: "连接失败",
    connectingSite: "正在连接网站…",
    resuming: "正在继续任务",
    handlingTask: "正在处理当前任务",
    executing: "正在执行已知步骤",
    validating: "正在确认执行结果",
    recording: "正在记录你的操作",
    learning: "正在整理刚才的经验",
    taskFailed: "任务没有完成",
    taskDone: "任务已完成",
  },
  progress: {
    title: "正在处理",
    text: "正在理解当前页面…",
    understanding: "正在理解你的目标",
    syncing: "正在同步最新能力并选择下一步…",
    generating: "正在生成回答",
    organizing: "已拿到工具结果，正在组织成清晰答复…",
    usingTools: "正在使用工具",
    reasoning: "结合上下文、工具结果和当前页面继续决策",
    afterTools: "执行完成后会继续由 Agent 形成回答",
    composing: "正在整理工具返回并生成答复…",
  },
  outcome: {
    "no-result": "没有结果",
    "business-rejection": "未能执行",
    "execution-fault": "执行中断",
    unknown: "需要确认",
  } as Record<string, string>,
  action: {
    retry: "再试一次",
    verify: "只读核对页面结果",
    confirm: "确认继续执行一次",
    demonstrate: "我操作一次给你看",
  },
  /**
   * Failure explanations. Each answers two things: what happened, and what you can do
   * next. A bare error code dumps troubleshooting on the visitor, who can neither see
   * logs nor change the system.
   */
  error: {
    inputRequired: "要继续完成这个目标，我还需要你补充一项信息。",
    modelNotConfigured: "网站助手暂时还没有准备好。你可以稍后重试。",
    budgetExhausted: "本次页面执行达到上限，已停止且不会自动重复动作。你可以先进行一次只读核对，确认页面是否已经产生结果。",
    tooLong: "这次处理时间有点长，没有可靠完成。你可以重试，或者操作一次给我看。",
    protocol: "我没有正确执行其中一步，这次任务已停止。",
    demonstrationEmpty: "还没有记录到网页操作，请先在网站中完成任务。",
    cancelled: "任务已停止。",
    alreadyRunning: "这个任务正在另一个页面继续，请先等待它完成。",
    stillFinishing: "上一个任务还没结束，请稍等片刻再试。",
    alreadyRunningHere: "这个任务正在另一个页面继续，本页不会重复执行。",
    checkpointLost: "页面已恢复，但上一次任务缺少可继续的检查点。请从控制台重新运行。",
    checkpointLostSummary: "页面已经恢复，但没有找到可继续的任务检查点。",
    generic: "这次操作遇到了问题，没有可靠完成。",
  },
  suggestion: {
    pinned: "固定建议",
    freshCapability: "新版能力，可直接使用",
    knowledgeCompiled: "网站知识编译，可直接使用",
    ready: "可以直接完成",
    needsInput: "需要先补充信息",
    tryIt: "你可以试试",
  },
  activity: {
    navigationTool: (name: string) => `导航工具 · ${name}`,
    capabilityCall: (name: string) => `调用能力 · ${name}`,
    knowledge: "查询网站知识",
    sitePath: (name: string) => `使用网站路径 · ${name}`,
    operatePage: "操作当前页面",
    deciding: "理解目标并选择下一步",
    pageHandedOver: "页面已接管",
    tool: {
      click_element_by_index: "点击页面控件",
      input_text: "填写页面内容",
      select_dropdown_option: "选择页面选项",
      scroll: "浏览页面内容",
      wait: "等待页面更新",
    } as Record<string, string>,
  },
  tools: {
    label: "操作记录",
    running: "执行中",
    done: "已结束",
    failed: "包含未完成步骤",
    navigation: "导航工具",
    knownCapability: "已知能力",
    programProgress: (completed: number, total: number) => `执行已验证程序 · ${completed}/${total} 步`,
    programPreparing: "正在准备已验证程序",
    capabilityFailed: "能力执行未完成",
    structuredDone: "结构化结果已返回给 Agent",
    stepDone: "已完成",
  },
  form: {
    fillIn: "请补充完成任务所需的信息",
    cancel: "取消",
    continue: "继续",
    start: "开始",
    inputFor: (name: string) => `请输入${name}`,
    dateExample: "例如：昨天、2026-07-17",
    dateInvalid: "请输入“昨天”或有效的 YYYY-MM-DD 日期",
    dateHint: "可输入“今天 / 昨天 / 前天”或 YYYY-MM-DD",
    dateExampleSuffix: (example: string) => ` · 示例 ${example}`,
    dateResolved: (value: string) => `将查询：${value}`,
    exampleList: (examples: string) => `示例：${examples}`,
  },
  message: {
    needMoreInfo: "我已经理解你要完成的事情，还需要补充下面的信息。",
    readOnlyCheck: "正在启动一次只读核对（最多 30 秒、2 次模型请求）；不会点击、输入或提交。",
    confirmedContinue: "你已确认继续。正在启动一次新的执行任务（最多 90 秒、5 次模型请求），本次不会再次自动续跑。",
    stopped: "任务已停止。",
  },
};

export type WidgetCopy = typeof zh;

const en: WidgetCopy = {
  launcher: {
    open: "Open the site assistant",
    prompt: "Tell SiteWake what you need",
  },
  panel: {
    label: "Site assistant",
    agentName: "Site assistant",
    newChat: "Start a new chat",
    close: "Close",
    language: "Language",
    runTrace: "Run log",
  },
  empty: {
    title: "What would you like to do on this site?",
    body: "Just say what you want. I will work on the page you are on, and tell you the result when it is done.",
  },
  teach: {
    bannerTitle: "I am watching how you do it",
    bannerBody: "Complete the goal on the page, then use the button on the right.",
    finish: "I'm done",
    finishDemo: "Finish demo",
    preparing: "Getting the demo ready…",
    awaitingAction: "Waiting for a page action",
    goalFallback: "Demonstrate a task",
    steps: (count: number) => `${count} step${count === 1 ? "" : "s"}`,
    recording: "Recording your actions",
    prompt: (goal: string) => `Go ahead and do “${goal}” on the page. Come back and press “I'm done” when you have finished.`,
    cancelled: "Demonstration cancelled; nothing was recorded.",
  },
  composer: {
    placeholder: "Give SiteWake a goal…",
    send: "Send",
    stop: "Stop",
    poweredBy: "Powered by SiteWake",
    modeHint: "Powered by SiteWake · runs on this page",
    teachIntentHint: "First, tell me what this demonstration should achieve",
    teachingHint: "Work through it on the site, then press “I'm done”",
    busyHint: "Working on it on this page",
    teachIntentPlaceholder: "What should this demonstration achieve?",
  },
  status: {
    connecting: "Connecting…",
    connected: "Connected — ready when you are",
    answering: "Answering",
    generating: "Writing the answer",
    failed: "Connection failed",
    connectingSite: "Connecting to the site…",
    resuming: "Resuming the task",
    handlingTask: "Working on the task",
    executing: "Running the known steps",
    validating: "Checking the result",
    recording: "Recording what you do",
    learning: "Making sense of what you just did",
    taskFailed: "The task did not finish",
    taskDone: "Task complete",
  },
  progress: {
    title: "Working on it",
    text: "Reading the current page…",
    understanding: "Understanding your goal",
    syncing: "Syncing the latest capabilities and picking the next step…",
    generating: "Writing the answer",
    organizing: "Got the tool results; putting them into a clear answer…",
    usingTools: "Using tools",
    reasoning: "Deciding from the context, the tool results and the current page",
    afterTools: "Once this finishes I will turn it into an answer",
    composing: "Turning the tool results into an answer…",
  },
  outcome: {
    "no-result": "No results",
    "business-rejection": "Could not proceed",
    "execution-fault": "Interrupted",
    unknown: "Needs a check",
  } as Record<string, string>,
  action: {
    retry: "Try again",
    verify: "Check the page read-only",
    confirm: "Run it once more",
    demonstrate: "Let me show you",
  },
  error: {
    inputRequired: "To finish this I need one more piece of information from you.",
    modelNotConfigured: "The site assistant is not ready yet. Please try again shortly.",
    budgetExhausted: "This run hit its limit on the page and stopped; it will not repeat any action on its own. You can run a read-only check first to see whether the page already changed.",
    tooLong: "This took too long to complete reliably. You can try again, or show me how once.",
    protocol: "I did not carry out one of the steps correctly, so the task stopped.",
    demonstrationEmpty: "No page actions were recorded yet — complete the task on the site first.",
    cancelled: "Task stopped.",
    alreadyRunning: "This task is still running on another page. Wait for it to finish first.",
    stillFinishing: "The previous task is still finishing. Try again in a moment.",
    alreadyRunningHere: "This task is still running on another page, so it will not run again here.",
    checkpointLost: "The page came back, but the previous task left no checkpoint to resume from. Please run it again from the console.",
    checkpointLostSummary: "The page came back, but no resumable checkpoint was found.",
    generic: "Something went wrong and this did not complete reliably.",
  },
  suggestion: {
    pinned: "Pinned",
    freshCapability: "New capability, ready to use",
    knowledgeCompiled: "Compiled from site knowledge, ready to use",
    ready: "Ready to run",
    needsInput: "Needs some details first",
    tryIt: "Worth a try",
  },
  activity: {
    navigationTool: (name: string) => `Navigation · ${name}`,
    capabilityCall: (name: string) => `Capability · ${name}`,
    knowledge: "Searching site knowledge",
    sitePath: (name: string) => `Site path · ${name}`,
    operatePage: "Working on the current page",
    deciding: "Understanding the goal and picking the next step",
    pageHandedOver: "Page handed over",
    tool: {
      click_element_by_index: "Clicking a control",
      input_text: "Filling in a field",
      select_dropdown_option: "Choosing an option",
      scroll: "Scrolling the page",
      wait: "Waiting for the page",
    } as Record<string, string>,
  },
  tools: {
    label: "Activity",
    running: "Running",
    done: "Finished",
    failed: "Includes failed steps",
    navigation: "Navigation",
    knownCapability: "Known capability",
    programProgress: (completed: number, total: number) => `Running a verified program · step ${completed}/${total}`,
    programPreparing: "Getting the verified program ready",
    capabilityFailed: "The capability did not finish",
    structuredDone: "Structured result returned to the agent",
    stepDone: "Done",
  },
  form: {
    fillIn: "Add the information this task needs",
    cancel: "Cancel",
    continue: "Continue",
    start: "Start",
    inputFor: (name: string) => `Enter ${name}`,
    dateExample: "e.g. yesterday, 2026-07-17",
    dateInvalid: "Enter “yesterday” or a valid YYYY-MM-DD date",
    dateHint: "You can type “today / yesterday” or YYYY-MM-DD",
    dateExampleSuffix: (example: string) => ` · e.g. ${example}`,
    dateResolved: (value: string) => `Will look up: ${value}`,
    exampleList: (examples: string) => `Examples: ${examples}`,
  },
  message: {
    needMoreInfo: "I understand what you want to do; I just need the details below.",
    readOnlyCheck: "Starting a read-only check (up to 30 seconds, 2 model requests). Nothing will be clicked, typed or submitted.",
    confirmedContinue: "Confirmed. Starting a new run (up to 90 seconds, 5 model requests); it will not auto-continue again this time.",
    stopped: "Task stopped.",
  },
};

/**
 * Which copy the widget shell shows. Three layers, highest priority first:
 *
 *  1. **Typed by the operator** (`overrides`). What they wrote stands, in any
 *     language — it is a person's wording choice for their own site, not ours to
 *     rewrite by visitor language.
 *  2. **Generated by the server from site knowledge**, when its language matches the
 *     visitor. It carries site context ("What do you want to do on the Weibo charts?")
 *     and beats a generic sentence, provided the visitor can read it.
 *  3. **The widget's built-in dictionary.** The fallback when languages do not match:
 *     generic, but at least in the visitor's language.
 *
 * Without layer 2, Chinese visitors regress from a personalized greeting to a generic
 * one — a regression, not i18n. A pure function so it can be tested directly: with
 * the precedence reversed the UI looks fine, and only switching language or site
 * reveals it.
 */
export function resolveChromeCopy(
  config: {
    generatedLocale?: WidgetLocale;
    overrides?: { displayName?: string; welcomeTitle?: string; welcomeDescription?: string };
    brand: { displayName: string; launcherLabel: string };
    copy: { welcomeTitle: string; welcomeDescription: string; composerPlaceholder: string; poweredByText: string };
  },
  locale: WidgetLocale,
) {
  const catalog = widgetCopy(locale);
  const generatedUsable = (config.generatedLocale || "zh") === locale;
  const pick = (override: string | undefined, generated: string, fallback: string) =>
    override?.trim() || (generatedUsable ? generated : fallback);
  return {
    displayName: pick(config.overrides?.displayName, config.brand.displayName, catalog.panel.agentName),
    launcherLabel: generatedUsable ? config.brand.launcherLabel : catalog.launcher.open,
    welcomeTitle: pick(config.overrides?.welcomeTitle, config.copy.welcomeTitle, catalog.empty.title),
    welcomeDescription: pick(config.overrides?.welcomeDescription, config.copy.welcomeDescription, catalog.empty.body),
    composerPlaceholder: generatedUsable ? config.copy.composerPlaceholder : catalog.composer.placeholder,
    poweredByText: generatedUsable ? config.copy.poweredByText : catalog.composer.poweredBy,
  };
}

/**
 * Picks the capability name by visitor language.
 *
 * The capability center always stored bilingual names; the release projection dropped
 * them, so the widget could only show name — which the proposal path sets to the
 * **English** name, so Chinese visitors saw English capability names. Not "adding
 * i18n", but reconnecting a field that existed and was lost on the way.
 *
 * Falls back to name: old releases lack the field, and old and new data must both work.
 */
export function localizedCapabilityName(
  capability: { name: string; localizedNames?: { zhCN?: string; en?: string } },
  locale: WidgetLocale,
) {
  const localized = locale === "en" ? capability.localizedNames?.en : capability.localizedNames?.zhCN;
  return localized?.trim() || capability.name;
}

const CATALOGS: Record<WidgetLocale, WidgetCopy> = { zh, en };

export function widgetCopy(locale: WidgetLocale): WidgetCopy {
  return CATALOGS[locale] || CATALOGS[DEFAULT_LOCALE];
}

export { zh as widgetZh, en as widgetEn };
