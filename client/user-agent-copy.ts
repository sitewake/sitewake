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
/** Every language a reader can be in, so generated copy can be written for each. */
export const WIDGET_LOCALES = ["zh", "en"] as const satisfies readonly WidgetLocale[];

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

/** The payload comes off the wire, so a list that is not one is printed as what it is. */
function listed(value: readonly string[] | string, separator: string) {
  if (Array.isArray(value)) return value.join(separator);
  return String(value ?? "");
}

const zh = {
  launcher: {
    open: "打开网站助手",
    prompt: "告诉 SiteWake 你想做什么",
  },
  /** Printed in the host page's console: read by the developer installing SiteWake, not by a visitor. */
  diagnostics: {
    originNotRegistered: (origin: string, registered: readonly string[] | string) =>
      `[SiteWake] 这个页面的地址 ${origin} 不在网站的登记地址里（已登记：${listed(registered, "、")}）。`
      + `请在 SiteWake 控制台的网站设置里把它加进来，然后刷新页面。`,
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
  // What a visitor is told while the agent is working. Separate from `status`
  // above, which is the connection state in two or three words.
  run: {
    connectingSiteAgent: "正在连接网站 SiteAgent…",
    connectedVersion: (version: number) => `SiteAgent v${version} 已连接`,
    resumedFromPage: "已接管上一页面的任务，正在继续…",
    resumedOnNewPage: "同一个 Agent 已在新页面恢复。",
    taskAlreadyDone: "任务已经完成。",
    earlierTaskDone: "刚才的任务已经完成。",
    continuedElsewhere: "任务已在另一个页面继续。",
    resumedValidationElsewhere: "页面任务已恢复；能力验证会在独立环境继续。",
    movedWithinPage: "已在当前页面更新位置，Agent 将继续执行…",
    continuingInNewTab: "任务将在新页面继续…",
    enteringNextPage: "正在进入下一页，Agent 会自动继续…",
    demonstrating: (goal: string) => `正在演示：${goal}`,
    stepDone: (name: string, step: string) => `${name} · ${step} 已完成`,
    verifyingReplay: "正在独立核验重放结果…",
    verifyingOnRealPage: "正在用真实页面独立验证新能力…",
    doneHandedToLearning: "任务已完成；这次经验已交给独立学习环境继续设计和验证。",
    doneWithReason: (reason: string) => `任务已完成；${reason}`,
    composingFromResults: "正在根据执行结果整理回答…",
    generatingAnswer: "正在生成回答…",
    modelBusyRetry: (seconds: number) => `模型服务暂时繁忙，${seconds} 秒后重试…`,
    callingCapability: (name: string) => `正在调用能力：${name}`,
    capabilityDone: (name: string) => `能力已完成：${name}`,
    capabilityFailed: (name: string) => `能力执行失败：${name}`,
    stageDone: (name: string, stage: string) => `${name} · ${stage} 已完成`,
    startingPageTool: "需要继续操作网页，正在启动网页工具…",
    continuingWithToolResults: "正在结合工具结果继续处理…",
    understandingRequest: "正在理解你的需求…",
    searchingCapabilities: "正在搜索已发布能力…",
    searchingKnowledge: "正在查询网站知识…",
    foundCapabilities: "已找到可用能力。",
    gotKnowledge: "已获取相关网站知识。",
    capabilityCatalogUnavailable: "能力目录暂时无法查询。",
    capabilityCatalogFailed: "能力目录访问失败，将尝试其他方式。",
    foundCandidates: (count: number) => `找到 ${count} 个候选能力，正在判断适用性。`,
    enteringSceneViaKnowledge: (scene: string) => `正在通过网站知识库进入「${scene}」…`,
    enteringScene: (scene: string) => `正在进入「${scene}」，随后继续任务…`,
    continuedToNewPage: "已继续到新页面",
    resumedRecording: "已从上一页面继续录制",
    resumedRecordingProgress: "已恢复上一页面的录制进度",
    waitingForYou: "等待你在网站中完成目标",
    capabilityList: "查询可用能力",
    demoClick: "点击",
    demoSelect: "选择",
    demoFill: "填写",
    recordingStarted: "录制已开始，请在网站中完成目标",
    demonstrated: (goal: string) => `已演示：${goal}`,
    taskDone: "任务已完成",
    taskNotDone: "任务未完成",
    taskStopped: "任务已停止。",
    capabilityReturned: "能力已执行并返回结果",
    capabilityUnreliable: "能力执行未可靠完成",
    completedGoal: (goal: string) => `已完成：${goal}`,
    fallbackCapabilityName: "能力",
    operateThisPage: "操作当前页面",
    viewAndOperate: "查看并操作当前页面",
    knowledgeMatch: "网站知识匹配",
    pageEntry: "当前页面操作入口",
    readingPage: "准备读取当前页面",
    resumeAndRead: "恢复任务并准备读取结果页",
    understandAndChoose: "理解目标并选择下一步",
    organizeFromTools: "根据工具结果组织回答",
    goalDoneFinalReply: "目标已完成，已生成最终回复",
    notReliablyDone: "本次执行未可靠完成，已生成原因说明",
    greeting: "你好！有什么我可以帮你的吗？",
    enteredSceneCarryOn: "已进入目标入口，继续原任务。",
    enteredNewPageCarryOn: "已进入新页面，继续刚才的任务…",
    pageRestoredCarryOn: "页面已恢复，继续刚才的任务…",
    resumedReadingPage: "已恢复到新页面，正在读取页面内容…",
    enterScene: (scene: string) => `进入${scene}`,
    arrivedElsewhere: "到达页面与预期入口不同，需要重新判断。",
    notProvided: "未提供",
    valueProvided: "已提供值",
    currentInputs: "当前输入条件",
    quotedField: (value: string, label: string) => `“${value}”（${label}）`,
    labelledValue: (label: string, value: string) => `${label}：${value}`,
    listSeparator: "、",
    targetNotFound: (target: string, name: string) => `当前页面中没有找到${target}，因此未执行“${name}”。`,
    modelNoResponse: "AI 模型这次没有及时响应，任务停在启动阶段，尚未操作网页。稍后重试即可；如果同时正在生成能力，等它结束后再试会更快。",
    capabilityMetadataInvalid: "已发布能力的可选描述信息不完整，任务在选择工具前停止；尚未操作网页。",
    sceneRouteFailed: "网站知识返回的页面入口不可直接使用，主 Agent 未能找到可执行路径；尚未操作网页。请重试或明确要进入的页面。",
    routingExhausted: "主 Agent 在能力与网站知识之间反复选择，未能在本次轮次内确定执行路径；尚未操作网页。请重试或明确要执行的操作。",
    runtimeStartFailed: "任务在启动阶段中断；尚未操作网页。系统已保留错误原因。",
    connectingToSite: "正在连接网站",
    usingNavigationTool: (name: string) => `正在使用导航工具：${name}`,
    validationInsufficient: "独立核验暂时无法确认这次重放已经完成目标。",
    resultNotSaved: "页面执行结果未能可靠保存，任务保持未关闭，不能确认能力闭环成功。请检查连接后从原任务恢复。",
    readOnlyCheckUnknown: "只读核对无法可靠确认页面是否已经产生结果。核对状态为 unknown，任务已停止且不会继续操作。",
    confirmedStepUnreliable: "你确认后的单次继续执行未能可靠确定动作结果，任务已停止，不会自动重试或修复。",
    stoppedNoRetry: "任务已停止，不会自动重试或修复。",
    pageExecutionCapped: "本次页面执行达到上限或无法可靠确定动作结果，已停止且不会自动重复动作。你可以先进行一次只读核对。",
    completedGoalNoData: (goal: string) => `已完成：${goal}\n\n该能力没有返回可展示的业务数据。`,
    completedGoalWithData: (goal: string, lines: string) => `已完成：${goal}\n\n${lines}`,
    completedGoalResultReturned: (goal: string) => `已经完成“${goal}”，结果已返回。`,
    completedGoalQuoted: (goal: string) => `已经完成“${goal}”。`,
    outcomeSceneBindingMissing: "这项能力的输入没有正确绑定到目标页面，系统已记录为能力回归。本次任务没有完成。",
    outcomeCapabilityPlanNotFound: "这项能力目前缺少适用于当前页面的可靠执行路径，系统已记录问题。本次任务没有完成。",
    outcomeOperationNotFound: "这项能力引用的执行步骤已失效，系统已记录问题。本次任务没有完成。",
    outcomeOperationImplementationNotFound: "这项能力还没有可执行的可靠程序，系统已记录问题。本次任务没有完成。",
    outcomeTargetNotFound: "网页结构发生了变化，原有操作目标已失效，系统已记录问题。本次任务没有完成。",
    outcomeTechnicalFault: "能力执行遇到了技术问题，系统已保留真实错误证据并进入修复流程。本次任务没有完成。",
    capabilityNoUsableResult: (name: string) => `能力“${name}”未产生可用结果。`,
    enteredSceneViaKnowledge: (scene: string) => `已通过网站知识库进入「${scene}」页面。`,
    usingVerifiedEntry: (scene: string) => `使用已验证入口进入「${scene}」`,
    readOnlyModeNotice: "当前站点助手处于只读模式，可以帮你查询信息或进入公开页面，但不会提交、保存或修改任何数据。",
    unverifiedSceneOnly: "网站知识库只找到了未验证的页面入口，未能证明目标页面已经打开；本次没有操作网页。请重试，或明确要打开的页面入口。",
    unverifiedSceneSummary: "网站知识返回的页面入口未验证，不能把其他页面当作成功结果。",
    searchPublishedCapabilities: "搜索已发布能力",
    queryKnowledge: "查询网站知识",
    knownPathBrokenRepairing: "已知路径失效，页面内 Agent 正在增量修复…",
    newGoalInPage: "这是新目标，页面内 Agent 正在当前页面完成…",
    reconciliationCompleted: "只读核对确认原目标已经完成。",
    reconciliationNotCompleted: "只读核对明确显示原目标尚未完成。",
    reconciliationUnknown: "只读核对无法可靠确认页面是否已经产生结果。任务已停止且不会继续操作。",
    reconciliationIncomplete: "只读核对未能完成；页面没有被继续操作。若要继续执行，需要你明确确认后启动一次新的任务。",
    confirmedStepTechnicalIssue: "你确认后的单次继续执行遇到技术问题，任务已停止且不会自动续跑。",
    demoEnter: "回车",
    demonstratedActions: (count: number) => `用户演示了 ${count} 个页面动作。`,
  },
  page: {
    backgroundWaitExhausted: "页面切走的时间太久，任务已经停止，没有继续操作。回到这个页面重新发起就可以。",
    wallClockExhausted: "这个任务用时过长，已经停止，避免让你一直等下去。可以换一个更具体的说法再试一次。",
    pageHandoffTimeout: "页面跳转没有完成，任务已经停止，后面的步骤没有执行。回到页面重新发起一次就可以。",
    userUnanswered: "等待你的回复超时，任务已经停止。补上刚才那项信息后重新发起即可。",
    activeTimeExhausted: "这个任务在页面上执行的时间用尽，已经停止。可以换一个更具体的说法再试一次。",
    modelRequestsExhausted: "这个任务尝试的步骤太多，已经停止。把目标拆小一点再试会更容易完成。",
    noProgress: "连续几步都没有让页面产生变化，任务已经停止。可能这个页面上没有对应的入口。",
    faultEvidenceDrain: "页面执行记录没能及时保存，任务已经停止，页面上的操作没有继续。可以重新发起一次。",
    faultObservationMissing: "读取页面状态时出了问题，任务已经停止。刷新页面后重新发起即可。",
    faultSensitiveTarget: "这一步需要填写密码或验证码，出于安全我不会代填，任务已经停止。",
    faultDuplicateAction: "同一个操作重复了多次仍没有效果，任务已经停止。",
    faultRoundUnsettled: "页面执行没有正常收尾，任务已经停止。可以重新发起一次。",
    faultReadOnlyNotAuthorized: "这个目标需要在页面上实际操作，你没有授权，所以我只做了查看。",
    faultWithCode: (code: string) => `页面执行遇到问题（${code}），任务没有完成。`,
    faultGeneric: "页面操作遇到了技术问题，本次任务没有完成。",
    thinking: "正在理解页面并规划下一步…",
    executing: "正在操作当前页面…",
    executed: "页面已更新，正在继续…",
    retrying: "正在重新理解这一步…",
    authorizeQuestion: (what: string) => `这一步需要我在页面上实际操作（${what}），要继续吗？`,
    authorizeYes: "继续",
    authorizeNo: "不要操作",
    authorizedByUser: "用户授权在页面上执行操作。",
    refusedByUser: "用户拒绝在页面上执行操作。",
    actionClick: "点击页面元素",
    actionFill: "填写内容",
    actionSelect: "选择选项",
    actionNavigate: "跳转到目标页面",
    actionGeneric: (action: string) => `执行 ${action}`,
    leavesSiteBlocked: (origin: string) => `这个链接会离开本站（${origin}），无法在站外继续执行。请选择本站内的链接或控件。`,
    positionUpdated: "已在当前页面更新位置。",
    readingResultEvidence: "正在读取结果页证据…",
    readingPageContent: "正在读取当前页面内容…",
    labelReadResultEvidence: "读取结果页证据",
    labelReadPageContent: "读取当前页面内容",
    labelResultEvidenceRead: "结果页证据已读取",
    labelPageEvidenceRead: "页面证据已读取",
    resultEvidenceReadNext: "结果页证据已读取，正在判断下一步…",
    pageEvidenceReadNext: "页面证据已读取，正在判断下一步…",
    labelQueryKnowledge: "查询网站知识",
    queryingKnowledge: (query: string) => `正在查询网站知识：${query}`,
    knowledgeFound: (scenes: number, routes: number, capabilities: number) => `找到 ${scenes} 个相关页面、${routes} 条路径和 ${capabilities} 项可调用能力。`,
    labelSiteKnowledge: "网站知识",
    labelUsingKnowledge: "使用网站知识",
    labelAlreadyThere: "已在目标页面",
    labelShortestEntry: "已选择最短入口",
    usingVerifiedEntry: (scene: string) => `使用已验证入口进入“${scene}”`,
    labelWaitingForUser: "等待用户补充",
    needOneMoreThing: "还需要你补充一项信息…",
    userAnswered: (answer: string) => `用户已回答：${answer}`,
    labelUserAnswered: "用户已补充信息",
    gotItContinuing: "已收到补充信息，继续任务…",
    labelOperatePage: "操作当前页面",
    labelPageAction: "页面操作",
    labelComposeFromCapability: "整理能力返回结果",
    labelReadResultPage: "读取结果页证据",
    labelUnderstandAndChoose: "理解目标并选择下一步",
    labelAdjustPlan: "调整执行计划",
    confirmQuestion: (goal: string) => `我已执行页面动作，但 AI 暂时无法确认“${goal}”是否成功。请选择这次动作的结果。选择“成功”会把这次真实操作交给后续能力生成与校验流程，是否可信由后续模块决定。`,
    waitingForConfirmation: "等待你确认页面动作结果…",
    labelConfirmResult: "确认动作结果",
    confirmYes: "成功",
    confirmNo: "失败",
    userConfirmedSuccess: "用户确认页面动作已成功完成。",
    userConfirmedFailure: "用户确认页面动作未成功，任务已停止且不会自动重试。",
    userCouldNotConfirm: "无法确认页面动作是否成功，任务已停止且不会自动重试。",
    missingBoundFields: (fields: string) => `页面动作尚未绑定用户指定的字段（${fields}），因此这次操作不能判定为完成。`,
    missingVisibleEvidence: "页面上缺少能够逐项证明完成条件的可见证据，因此这次操作不能判定为完成。",
    missingInputApplied: "页面上还没有实际应用用户指定的输入值，因此这次操作尚未完成。",
    missingAction: "页面上还没有执行原始目标要求的动作，因此这次操作尚未完成。",
    noExpectedEffect: "页面操作没有产生预期效果，任务没有完成。",
    notFinishedYet: "我还没有完成这个目标。",
    capabilityCallFailed: (name: string) => `能力调用失败：${name}`,
    checkingOriginalAction: "正在核对原始操作是否真正完成…",
    labelCheckFinalEvidence: "核对最终动作证据",
    traceStopped: "已停止",
    traceThinking: "正在思考下一步…",
    traceNeedsAttention: "部分操作未完成",
    traceCompleted: "已完成操作",
    traceDetails: "查看过程",
    traceRowRunning: "进行中",
    traceRowFailed: "未完成",
    traceRowDone: "完成",
    sensitiveTargetNeedsYou: (name: string) => `敏感控件“${name}”必须由用户操作`,
    targetMissing: (name: string) => `没有找到“${name}”`,
    targetAmbiguous: (name: string) => `“${name}”存在多个候选`,
    targetObscured: "目标被其他元素遮挡",
    notStarted: "尚未开始",
    connectionTimedOut: "连接超时。",
    connectionFailed: "暂时无法连接助手服务。",
    couldNotPrepare: "助手未能完成任务准备。",
    nothingWasDone: "尚未操作网页，可以重试。",
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
  diagnostics: {
    originNotRegistered: (origin: string, registered: readonly string[] | string) =>
      `[SiteWake] This page is at ${origin}, which is not one of this website's registered addresses (${listed(registered, ", ") || "none"}). `
      + `Add it in the website's settings in the SiteWake console, then reload.`,
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
  run: {
    connectingSiteAgent: "Connecting to the site’s agent…",
    connectedVersion: (version: number) => `Site agent v${version} connected`,
    resumedFromPage: "Picked up the task from the previous page; carrying on…",
    resumedOnNewPage: "The same agent has resumed on the new page.",
    taskAlreadyDone: "The task is already done.",
    earlierTaskDone: "That earlier task is already done.",
    continuedElsewhere: "The task has continued on another page.",
    resumedValidationElsewhere: "The page task has resumed; the capability is being verified separately.",
    movedWithinPage: "Moved to the new place on this page; carrying on…",
    continuingInNewTab: "The task will continue in the new tab…",
    enteringNextPage: "Opening the next page; the agent will carry on by itself…",
    demonstrating: (goal: string) => `Demonstrating: ${goal}`,
    stepDone: (name: string, step: string) => `${name} · ${step} done`,
    verifyingReplay: "Checking the replay independently…",
    verifyingOnRealPage: "Verifying the new capability on the real page…",
    doneHandedToLearning: "Task complete; what it learned has gone to a separate environment to be designed and verified.",
    doneWithReason: (reason: string) => `Task complete; ${reason}`,
    composingFromResults: "Putting the answer together from what ran…",
    generatingAnswer: "Writing the answer…",
    modelBusyRetry: (seconds: number) => `The model is busy; retrying in ${seconds}s…`,
    callingCapability: (name: string) => `Calling ${name}…`,
    capabilityDone: (name: string) => `${name} — done`,
    capabilityFailed: (name: string) => `${name} — failed`,
    stageDone: (name: string, stage: string) => `${name} · ${stage} done`,
    startingPageTool: "This needs more work on the page; starting the page tool…",
    continuingWithToolResults: "Carrying on with what the tools returned…",
    understandingRequest: "Working out what you need…",
    searchingCapabilities: "Searching published capabilities…",
    searchingKnowledge: "Looking through what is known about this site…",
    foundCapabilities: "Found a capability for this.",
    gotKnowledge: "Got what is known about this.",
    capabilityCatalogUnavailable: "The capability catalogue cannot be reached right now.",
    capabilityCatalogFailed: "The capability catalogue could not be reached; trying another way.",
    foundCandidates: (count: number) => `Found ${count} possible capabilit${count === 1 ? "y" : "ies"}; working out which fits.`,
    enteringSceneViaKnowledge: (scene: string) => `Opening “${scene}” from what is known about this site…`,
    enteringScene: (scene: string) => `Opening “${scene}”, then carrying on…`,
    continuedToNewPage: "Continued to the new page",
    resumedRecording: "Recording resumed from the previous page",
    resumedRecordingProgress: "Picked up where the recording left off",
    waitingForYou: "Waiting for you to finish on the site",
    capabilityList: "Checking what it can do",
    demoClick: "Click",
    demoSelect: "Select",
    demoFill: "Type",
    recordingStarted: "Recording has started — complete the goal on the site",
    demonstrated: (goal: string) => `Demonstrated: ${goal}`,
    taskDone: "Task complete",
    taskNotDone: "Task not completed",
    taskStopped: "The task has stopped.",
    capabilityReturned: "The capability ran and returned a result",
    capabilityUnreliable: "The capability did not finish reliably",
    completedGoal: (goal: string) => `Done: ${goal}`,
    fallbackCapabilityName: "Capability",
    operateThisPage: "Work on this page",
    viewAndOperate: "Read and work on this page",
    knowledgeMatch: "Matched against what is known about this site",
    pageEntry: "Where to act on this page",
    readingPage: "Getting ready to read this page",
    resumeAndRead: "Resuming, then reading the result page",
    understandAndChoose: "Working out the goal and the next step",
    organizeFromTools: "Putting the answer together from the tools",
    goalDoneFinalReply: "Goal met; the final reply is written",
    notReliablyDone: "This run did not finish reliably; the reason is written up",
    greeting: "Hello. What can I help you with?",
    enteredSceneCarryOn: "Arrived at the entry; carrying on with the original task.",
    enteredNewPageCarryOn: "On the new page; carrying on…",
    pageRestoredCarryOn: "The page is back; carrying on…",
    resumedReadingPage: "Resumed on the new page; reading it…",
    enterScene: (scene: string) => `Open ${scene}`,
    arrivedElsewhere: "Ended up somewhere other than the expected entry; reconsidering.",
    notProvided: "not provided",
    valueProvided: "value provided",
    currentInputs: "the current inputs",
    quotedField: (value: string, label: string) => `“${value}” (${label})`,
    labelledValue: (label: string, value: string) => `${label}: ${value}`,
    listSeparator: ", ",
    targetNotFound: (target: string, name: string) => `“${name}” did not run: ${target} is not on this page.`,
    modelNoResponse: "The model did not answer in time, so the task stopped before touching the page. Try again shortly; if a capability is being generated at the same time, waiting for it to finish will be faster.",
    capabilityMetadataInvalid: "A published capability has incomplete optional metadata, so the task stopped before choosing a tool. The page was not touched.",
    sceneRouteFailed: "The page entry returned by site knowledge cannot be used directly, and the main agent found no workable route. The page was not touched. Try again, or name the page you want to open.",
    routingExhausted: "The main agent kept switching between capabilities and site knowledge without settling on a route this turn. The page was not touched. Try again, or name the action you want.",
    runtimeStartFailed: "The task was interrupted while starting; the page was not touched. The underlying error has been kept.",
    connectingToSite: "Connecting to the site",
    usingNavigationTool: (name: string) => `Using navigation tool: ${name}`,
    validationInsufficient: "Independent verification cannot yet confirm that this replay met the goal.",
    resultNotSaved: "The page result could not be saved reliably, so the task stays open and the capability cannot be called a success. Check the connection, then resume the original task.",
    readOnlyCheckUnknown: "The read-only check cannot reliably tell whether the page produced a result. The check is unknown, the task has stopped, and nothing further will be done.",
    confirmedStepUnreliable: "The single step you confirmed could not reliably determine its result. The task has stopped and will not retry or repair itself.",
    stoppedNoRetry: "The task has stopped and will not retry or repair itself.",
    pageExecutionCapped: "This page run hit its limit or could not reliably determine the result of an action. It has stopped and will not repeat the action. You can run a read-only check first.",
    completedGoalNoData: (goal: string) => `Done: ${goal}\n\nThis capability returned no data to show.`,
    completedGoalWithData: (goal: string, lines: string) => `Done: ${goal}\n\n${lines}`,
    completedGoalResultReturned: (goal: string) => `“${goal}” is done, and the result is below.`,
    completedGoalQuoted: (goal: string) => `“${goal}” is done.`,
    outcomeSceneBindingMissing: "This capability's inputs are not bound to the right page, which has been recorded as a capability regression. The task did not finish.",
    outcomeCapabilityPlanNotFound: "This capability has no reliable route for the current page, and the problem has been recorded. The task did not finish.",
    outcomeOperationNotFound: "A step this capability relies on no longer exists, and the problem has been recorded. The task did not finish.",
    outcomeOperationImplementationNotFound: "This capability has no reliable program to run yet, and the problem has been recorded. The task did not finish.",
    outcomeTargetNotFound: "The page changed and the original target no longer exists. The problem has been recorded. The task did not finish.",
    outcomeTechnicalFault: "The capability hit a technical problem. The real error has been kept and sent for repair. The task did not finish.",
    capabilityNoUsableResult: (name: string) => `“${name}” produced no usable result.`,
    enteredSceneViaKnowledge: (scene: string) => `Opened “${scene}” using site knowledge.`,
    usingVerifiedEntry: (scene: string) => `Opening “${scene}” through a verified entry`,
    readOnlyModeNotice: "This assistant is in read-only mode. It can look things up and open public pages, but it will not submit, save or change anything.",
    unverifiedSceneOnly: "Site knowledge only offered an unverified page entry, so there is no proof the page opened; nothing was done on the site. Try again, or name the page you want to open.",
    unverifiedSceneSummary: "The page entry from site knowledge is unverified, so another page cannot count as a success.",
    searchPublishedCapabilities: "Searching published capabilities",
    queryKnowledge: "Searching site knowledge",
    knownPathBrokenRepairing: "The known route broke; the in-page agent is repairing it…",
    newGoalInPage: "This is a new goal; the in-page agent is working on this page…",
    reconciliationCompleted: "The read-only check confirms the original goal was met.",
    reconciliationNotCompleted: "The read-only check shows the original goal was not met.",
    reconciliationUnknown: "The read-only check cannot reliably tell whether the page produced a result. The task has stopped and nothing further will be done.",
    reconciliationIncomplete: "The read-only check could not finish; the page was left alone. To go on, confirm and start a new task.",
    confirmedStepTechnicalIssue: "The single step you confirmed hit a technical problem. The task has stopped and will not continue on its own.",
    demoEnter: "Enter",
    demonstratedActions: (count: number) => `You demonstrated ${count} page action${count === 1 ? "" : "s"}.`,
  },
  page: {
    backgroundWaitExhausted: "This page was in the background too long, so the task stopped without doing anything further. Come back to this page and start again.",
    wallClockExhausted: "The task took too long and was stopped rather than leaving you waiting. Try again with something more specific.",
    pageHandoffTimeout: "The page never finished loading, so the task stopped and the remaining steps did not run. Go back to the page and start again.",
    userUnanswered: "The task stopped while waiting for your reply. Add that detail and start again.",
    activeTimeExhausted: "This task ran out of time on the page and has stopped. Try again with something more specific.",
    modelRequestsExhausted: "This task took too many steps and has stopped. Breaking the goal into smaller pieces will work better.",
    noProgress: "Several steps in a row changed nothing on the page, so the task stopped. This page may not have what the task needs.",
    faultEvidenceDrain: "The record of what happened on the page could not be saved in time, so the task stopped and went no further. You can start again.",
    faultObservationMissing: "Something went wrong reading the page, so the task stopped. Refresh the page and start again.",
    faultSensitiveTarget: "This step needs a password or verification code. For safety I will not fill those in, so the task stopped.",
    faultDuplicateAction: "The same action repeated several times with no effect, so the task stopped.",
    faultRoundUnsettled: "The page run did not finish cleanly, so the task stopped. You can start again.",
    faultReadOnlyNotAuthorized: "This goal needs real actions on the page and you did not authorize them, so I only looked.",
    faultWithCode: (code: string) => `Something went wrong on the page (${code}), and the task did not finish.`,
    faultGeneric: "Working on the page hit a technical problem, and the task did not finish.",
    thinking: "Reading the page and planning the next step…",
    executing: "Working on this page…",
    executed: "The page changed; carrying on…",
    retrying: "Rethinking this step…",
    authorizeQuestion: (what: string) => `This step needs a real action on the page (${what}). Go ahead?`,
    authorizeYes: "Go ahead",
    authorizeNo: "Don't",
    authorizedByUser: "The user authorized acting on the page.",
    refusedByUser: "The user declined to let the page be acted on.",
    actionClick: "click something on the page",
    actionFill: "type something in",
    actionSelect: "pick an option",
    actionNavigate: "open another page",
    actionGeneric: (action: string) => `run ${action}`,
    leavesSiteBlocked: (origin: string) => `That link leaves this site (${origin}), and I cannot carry on off-site. Pick a link or control on this site.`,
    positionUpdated: "Moved to a new spot on this page.",
    readingResultEvidence: "Reading the result page…",
    readingPageContent: "Reading this page…",
    labelReadResultEvidence: "Read the result page",
    labelReadPageContent: "Read this page",
    labelResultEvidenceRead: "Result page read",
    labelPageEvidenceRead: "Page read",
    resultEvidenceReadNext: "Result page read; working out the next step…",
    pageEvidenceReadNext: "Page read; working out the next step…",
    labelQueryKnowledge: "Searching site knowledge",
    queryingKnowledge: (query: string) => `Searching site knowledge: ${query}`,
    knowledgeFound: (scenes: number, routes: number, capabilities: number) => `Found ${scenes} related page${scenes === 1 ? "" : "s"}, ${routes} route${routes === 1 ? "" : "s"} and ${capabilities} capabilit${capabilities === 1 ? "y" : "ies"}.`,
    labelSiteKnowledge: "Site knowledge",
    labelUsingKnowledge: "Using site knowledge",
    labelAlreadyThere: "Already on the page",
    labelShortestEntry: "Shortest route chosen",
    usingVerifiedEntry: (scene: string) => `Opening “${scene}” through a verified entry`,
    labelWaitingForUser: "Waiting for you",
    needOneMoreThing: "I need one more detail from you…",
    userAnswered: (answer: string) => `You answered: ${answer}`,
    labelUserAnswered: "You filled in the detail",
    gotItContinuing: "Got it — carrying on…",
    labelOperatePage: "Working on this page",
    labelPageAction: "Page action",
    labelComposeFromCapability: "Writing up the capability result",
    labelReadResultPage: "Read the result page",
    labelUnderstandAndChoose: "Understand the goal and choose the next step",
    labelAdjustPlan: "Adjust the plan",
    confirmQuestion: (goal: string) => `I acted on the page, but cannot confirm whether “${goal}” succeeded. Tell me how it went. Choosing “It worked” sends this real run on to capability generation and verification, which decide for themselves whether to trust it.`,
    waitingForConfirmation: "Waiting for you to confirm how it went…",
    labelConfirmResult: "Confirm the result",
    confirmYes: "It worked",
    confirmNo: "It didn't",
    userConfirmedSuccess: "The user confirmed the page action succeeded.",
    userConfirmedFailure: "The user confirmed the page action failed. The task stopped and will not retry.",
    userCouldNotConfirm: "Whether the page action succeeded could not be confirmed. The task stopped and will not retry.",
    missingBoundFields: (fields: string) => `The page action is not bound to the values you gave (${fields}), so it cannot count as done.`,
    missingVisibleEvidence: "The page shows nothing that proves each completion condition, so this cannot count as done.",
    missingInputApplied: "The values you gave have not actually been applied on the page, so this is not done yet.",
    missingAction: "The action the goal asked for has not been performed on the page, so this is not done yet.",
    noExpectedEffect: "Working on the page had no effect, and the task did not finish.",
    notFinishedYet: "I have not finished this goal yet.",
    capabilityCallFailed: (name: string) => `Capability call failed: ${name}`,
    checkingOriginalAction: "Checking whether the original action really completed…",
    labelCheckFinalEvidence: "Check the final action evidence",
    traceStopped: "Stopped",
    traceThinking: "Working out the next step…",
    traceNeedsAttention: "Some actions need attention",
    traceCompleted: "Actions completed",
    traceDetails: "Details",
    traceRowRunning: "In progress",
    traceRowFailed: "Not completed",
    traceRowDone: "Done",
    sensitiveTargetNeedsYou: (name: string) => `“${name}” is a sensitive control and has to be used by you`,
    targetMissing: (name: string) => `“${name}” was not found`,
    targetAmbiguous: (name: string) => `“${name}” matches more than one control`,
    targetObscured: "Something else is covering the target",
    notStarted: "Not started",
    connectionTimedOut: "The connection timed out.",
    connectionFailed: "Could not connect to the assistant service.",
    couldNotPrepare: "The assistant could not prepare this task.",
    nothingWasDone: " No page actions were performed. You can retry.",
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
    generated?: Partial<Record<WidgetLocale, {
      displayName: string;
      launcherLabel: string;
      welcomeTitle: string;
      welcomeDescription: string;
      suggestions: string[];
    }>>;
    overrides?: { displayName?: string; welcomeTitle?: string; welcomeDescription?: string; pinnedSuggestions?: string[] };
    suggestions?: string[];
    brand: { displayName: string; launcherLabel: string };
    copy: { welcomeTitle: string; welcomeDescription: string; composerPlaceholder: string; poweredByText: string };
  },
  locale: WidgetLocale,
) {
  const catalog = widgetCopy(locale);
  // This site's own words in this reader's language, when the generator wrote
  // them. Older records carry a single set and say which language it is in.
  const written = config.generated?.[locale];
  const legacy = !config.generated && (config.generatedLocale || "zh") === locale;
  const pick = (override: string | undefined, generated: string | undefined, fallback: string) =>
    override?.trim() || generated?.trim() || fallback;
  const site = written || (legacy
    ? {
        displayName: config.brand.displayName,
        launcherLabel: config.brand.launcherLabel,
        welcomeTitle: config.copy.welcomeTitle,
        welcomeDescription: config.copy.welcomeDescription,
      }
    : undefined);
  return {
    displayName: pick(config.overrides?.displayName, site?.displayName, catalog.panel.agentName),
    launcherLabel: site?.launcherLabel || catalog.launcher.open,
    welcomeTitle: pick(config.overrides?.welcomeTitle, site?.welcomeTitle, catalog.empty.title),
    welcomeDescription: pick(config.overrides?.welcomeDescription, site?.welcomeDescription, catalog.empty.body),
    composerPlaceholder: catalog.composer.placeholder,
    poweredByText: catalog.composer.poweredBy,
    // Questions someone wrote are theirs whatever language they are reading in;
    // the site's own are offered in the language they are reading.
    suggestions: [
      ...(config.overrides?.pinnedSuggestions || []).map((item) => item.trim()).filter(Boolean),
      ...(written ? written.suggestions : legacy ? config.suggestions || [] : []),
    ].slice(0, 3),
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
