export type RunnerPageSummary = {
  url?: string;
  title?: string;
  heading?: string;
  text?: string;
};

export type RunnerFailureDiagnostic = {
  code: string;
  message: string;
  retryable: boolean;
  cause?: { code: string; message: string };
};

const ACCESS_CHALLENGE_MESSAGE = "目标网站拒绝了托管 Runner 的访问（页面要求完成 403/安全验证或验证码）。Runner 尚未进入业务页面，因此无法生成能力。请先为 Runner 配置访问白名单、可信出口 IP 或可复用的验证状态，然后重新运行任务。";

function normalized(value?: string) {
  return (value || "").normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

/** Detect access-control pages from high-confidence document signals. */
export function diagnoseBlockedPage(page: RunnerPageSummary): RunnerFailureDiagnostic | undefined {
  const url = normalized(page.url);
  const title = normalized(page.title);
  const heading = normalized(page.heading);
  const text = normalized(page.text).slice(0, 2_000);
  const documentLabel = `${title} ${heading}`;
  const challengeRoute = /(?:\/security\/(?:challenge|captcha|verify)|\/(?:captcha|challenge))(?:[/?#]|$)|(?:[?&](?:cf_chl|captcha|challenge)=)/i.test(url);
  const challengeLabel = /(?:安全验证|人机验证|验证码|滑块验证|访问受限|access denied|access restricted|verify (?:that )?you are human|security challenge|captcha|\b403\b|forbidden)/iu.test(documentLabel);
  const challengeWidget = /(?:拖动滑块|完成安全验证|请完成验证|aliyun.?captcha|cloudflare.*(?:challenge|verify)|captcha)/iu.test(text);
  if (challengeLabel || (challengeWidget && (challengeRoute || /(?:验证|verify|captcha|challenge)/iu.test(documentLabel)))) {
    return { code: "site_access_challenge", message: ACCESS_CHALLENGE_MESSAGE, retryable: false };
  }
  return undefined;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error || "");
}

function errorCode(error: unknown) {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code;
  return errorMessage(error).match(/^([a-z][a-z0-9_]+)(?=:|$)/i)?.[1];
}

function rootCause(error: unknown) {
  let current = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (!(current instanceof Error) || !current.cause) break;
    current = current.cause;
  }
  const message = errorMessage(current).replace(/\s+/g, " ").trim().slice(0, 1_000);
  return { code: errorCode(current) || "runner_root_cause", message };
}

const MODULE_LOAD_MESSAGE = "浏览器无法通过安全的公共地址加载能力模块，请检查 CAPABILITY_V2_BROWSER_PUBLIC_URL，并确认模块端点使用 HTTPS、返回 JavaScript MIME 类型，且 CORS、CSP 与 mixed-content 策略允许加载。";

export function diagnoseRunnerFailure(error: unknown, page?: RunnerPageSummary): RunnerFailureDiagnostic {
  const rawMessage = errorMessage(error);
  const code = errorCode(error);
  if (rawMessage.startsWith('case_generation_failed:')) return {
    code: 'case_evidence_incomplete',
    message: '独立验收尚未取得足够证据。候选代码和取证过程已保留，请检查工作区中的 validation 报告。',
    retryable: true,
    cause: {code:'case_generation_failed',message:rawMessage},
  };
  if (code === "javascript_author_tool_budget_exhausted") {
    const cause = rootCause(error);
    return {
      code: "authoring_budget_exhausted",
      message: "能力代码在可用的修复预算内仍未通过。请查看已脱敏的技术原因后重新运行。",
      retryable: true,
      cause,
    };
  }
  if (code === "module_load_failed") {
    return { code: "module_load_failed", message: MODULE_LOAD_MESSAGE, retryable: true, cause: rootCause(error) };
  }
  if (code === "browser_module_url_invalid") {
    return { code: "module_load_failed", message: MODULE_LOAD_MESSAGE, retryable: true, cause: rootCause(error) };
  }
  if (!code && /failed to fetch dynamically imported module|importing a module script failed|module script.*(?:cors|mime)|mixed[- ]content/i.test(rawMessage)) {
    return { code: "module_load_failed", message: MODULE_LOAD_MESSAGE, retryable: true, cause: rootCause(error) };
  }
  if (/javascript_author_tool_budget_exhausted/i.test(rawMessage)) {
    const cause = rootCause(error);
    return {
      code: "authoring_budget_exhausted",
      message: "能力代码在可用的修复预算内仍未通过。请查看已脱敏的技术原因后重新运行。",
      retryable: true,
      cause,
    };
  }
  if (/repeated_click_without_page_progress/i.test(rawMessage)) {
    return { code: "exploration_no_progress", message: "探索重复选择同一目标，但页面没有发生可观察变化。已停止重复操作，请查看动作结果中的目标和页面变化。", retryable: false };
  }
  if (/external_link_outside_exploration_scope/i.test(rawMessage)) {
    return { code: "exploration_target_outside_site", message: "探索选择了站外来源或分享链接，无法完成当前站点内的目标。请查看页面可点击目标的识别结果。", retryable: false };
  }
  if (/popup_transition_requires_page_handoff/i.test(rawMessage)) {
    return { code: "exploration_popup_transition", message: "该操作在新窗口中继续，当前探索执行器尚不支持此页面交接。已停止重复点击，并保留新窗口地址供排查。", retryable: false };
  }
  const blocked = page ? diagnoseBlockedPage(page) : undefined;
  if (blocked) return blocked;
  if (/interaction_timeout/i.test(rawMessage)) {
    return { code: "interaction_timeout", message: "任务等待管理员输入超时。请重新运行任务，并在任务进入“等待输入”后及时提交所需信息。", retryable: true };
  }
  if (/capability_model_timeout|tool_calling_model_timeout/i.test(rawMessage)) {
    return { code: "model_timeout", message: "AI 模型在规定时间内没有完成响应。请稍后重新运行；若持续发生，请检查模型服务状态和超时配置。", retryable: true };
  }
  if (/validation_runner_model_credentials_present/i.test(rawMessage)) {
    return { code: "validation_runner_isolation_failed", message: "Validation Runner 启动环境仍携带模型凭据，已阻止执行以保证验证阶段不调用 AI。请重启 Runtime Launcher 后重试。", retryable: true, cause: rootCause(error) };
  }
  if (/structured_model|tool_calling_protocol|tool_call_(?:type|id|name|required|unknown)|tool_argument|javascript_author_tool_unknown/i.test(rawMessage)) {
    return { code: "model_protocol_error", message: "AI 模型返回的结构不符合能力生成协议。系统已重试但仍未获得有效结果，请检查模型兼容性或稍后重新运行。", retryable: true };
  }
  if (/^auth(?:entication|_)/i.test(rawMessage)) {
    return { code: "authentication_failed", message: "Runner 无法完成目标网站的登录或身份验证。请检查任务所需账号、验证码或登录状态后重新运行。", retryable: true, cause: rootCause(error) };
  }
  if (/target_ambiguous/i.test(rawMessage)) {
    return { code: "target_ambiguous", message: "Runner 找到多个符合条件的页面目标，无法安全确定操作对象；为避免误操作，任务已经停止。请补充更明确的业务目标后重新运行。", retryable: false };
  }
  // The site itself cannot be opened over HTTPS (expired or invalid certificate).
  // Nothing about the recording or the generated code is at fault, and the
  // runner must not ignore TLS errors — visitors' browsers will not either.
  if (/net::ERR_CERT_[A-Z_]+|SSL_ERROR|certificate (?:has expired|verify failed|is not valid)/i.test(rawMessage)) {
    const host = rawMessage.match(/https?:\/\/([^\s/"']+)/)?.[1] || "";
    return {
      code: "site_certificate_invalid",
      message: `目标网站${host ? `（${host}）` : ""}的 HTTPS 证书无效或已过期，浏览器拒绝打开页面。请先更新网站证书，再重新运行。`,
      retryable: true,
      cause: rootCause(error),
    };
  }
  if (/locator_not_found|element|selector|playwright.*timeout|waiting for locator/i.test(rawMessage)) {
    return { code: "page_changed", message: "Runner 执行时找不到预期的页面元素，页面结构可能已经变化，或目标元素尚未加载。请查看截图或录屏确认页面状态后重新运行。", retryable: true };
  }
  return { code: "runner_execution_failed", message: `Runner 执行失败：${rawMessage || "未知错误"}`, retryable: true };
}
