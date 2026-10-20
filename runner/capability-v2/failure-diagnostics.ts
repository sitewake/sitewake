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

function normalized(value?: string) {
  return (value || "").normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase();
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

/**
 * A diagnosis names a code, and the console says what it means.
 *
 * A runner cannot know who will read the failure: it has no locale, and the
 * same record is opened by administrators in either language. Prose written
 * here was written in one of them, and reached the other through the panel's
 * engineering section even once the panel itself was translated. Every code
 * below has an entry in `capability.v2.failure` in both catalogs, which
 * `tests/capability-v2-failure-diagnostics.test.mjs` holds to. The technical
 * detail worth keeping travels in `cause`, which is not copy and is shown as
 * the engineering reason.
 */
function diagnosis(code: string, retryable: boolean, cause?: { code: string; message: string }): RunnerFailureDiagnostic {
  return { code, message: code, retryable, ...(cause ? { cause } : {}) };
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
    return diagnosis("site_access_challenge", false);
  }
  return undefined;
}

export function diagnoseRunnerFailure(error: unknown, page?: RunnerPageSummary): RunnerFailureDiagnostic {
  const rawMessage = errorMessage(error);
  const code = errorCode(error);
  if (rawMessage.startsWith("case_generation_failed:")) {
    return diagnosis("case_evidence_incomplete", true, { code: "case_generation_failed", message: rawMessage });
  }
  if (code === "javascript_author_tool_budget_exhausted") {
    return diagnosis("authoring_budget_exhausted", true, rootCause(error));
  }
  if (code === "capability_contract_inconsistent" || /capability_contract_inconsistent/i.test(rawMessage)) {
    return diagnosis("contract_inconsistent", true, rootCause(error));
  }
  // The only thing the replay refuses for. Surfaced as the raw predicate it
  // came from, it read as an internal rule number; what it means is that the
  // program the authoring turn wrote was never seen to work.
  if (/validation_no_case_produced_a_result/.test(rawMessage)) {
    return diagnosis("no_case_produced_a_result", true, rootCause(error));
  }
  // The page the capability opens took too long to load. Reported as an
  // authoring failure, it read as "the generated code is wrong" when nothing
  // in the code could have changed it.
  if (/capability_navigation_timeout:/.test(rawMessage)) {
    return diagnosis("navigation_timeout", true, rootCause(error));
  }
  // The capability ran out of its time budget before it finished. Reported as
  // an authoring failure it read as "the generated code is wrong", and the
  // model answered a clock with a rewrite.
  if (/capability_control_flow_timeout/.test(rawMessage)) {
    return diagnosis("control_flow_timeout", true, rootCause(error));
  }
  if (code === "javascript_author_repeated_failure" || /javascript_author_repeated_failure/i.test(rawMessage)) {
    return diagnosis("authoring_repeated_failure", true, rootCause(error));
  }
  if (code === "module_load_failed" || code === "browser_module_url_invalid") {
    return diagnosis("module_load_failed", true, rootCause(error));
  }
  if (!code && /failed to fetch dynamically imported module|importing a module script failed|module script.*(?:cors|mime)|mixed[- ]content/i.test(rawMessage)) {
    return diagnosis("module_load_failed", true, rootCause(error));
  }
  if (/javascript_author_tool_budget_exhausted/i.test(rawMessage)) {
    return diagnosis("authoring_budget_exhausted", true, rootCause(error));
  }
  if (/repeated_click_without_page_progress/i.test(rawMessage)) {
    return diagnosis("exploration_no_progress", false);
  }
  if (/external_link_outside_exploration_scope/i.test(rawMessage)) {
    return diagnosis("exploration_target_outside_site", false);
  }
  if (/popup_transition_requires_page_handoff/i.test(rawMessage)) {
    return diagnosis("exploration_popup_transition", false);
  }
  const blocked = page ? diagnoseBlockedPage(page) : undefined;
  if (blocked) return blocked;
  if (/interaction_timeout/i.test(rawMessage)) {
    return diagnosis("interaction_timeout", true);
  }
  if (/capability_model_timeout|tool_calling_model_timeout/i.test(rawMessage)) {
    return diagnosis("model_timeout", true);
  }
  if (/validation_runner_model_credentials_present/i.test(rawMessage)) {
    return diagnosis("validation_runner_isolation_failed", true, rootCause(error));
  }
  if (/structured_model|tool_calling_protocol|tool_call_(?:type|id|name|required|unknown)|tool_argument|javascript_author_tool_unknown/i.test(rawMessage)) {
    return diagnosis("model_protocol_error", true);
  }
  if (/^auth(?:entication|_)/i.test(rawMessage)) {
    return diagnosis("authentication_failed", true, rootCause(error));
  }
  if (/target_ambiguous/i.test(rawMessage)) {
    return diagnosis("target_ambiguous", false);
  }
  // The site itself cannot be opened over HTTPS (expired or invalid certificate).
  // Nothing about the recording or the generated code is at fault, and the
  // runner must not ignore TLS errors — visitors' browsers will not either.
  // The host stays in the cause, where the raw navigation error already names it.
  if (/net::ERR_CERT_[A-Z_]+|SSL_ERROR|certificate (?:has expired|verify failed|is not valid)/i.test(rawMessage)) {
    return diagnosis("site_certificate_invalid", true, rootCause(error));
  }
  if (/locator_not_found|element|selector|playwright.*timeout|waiting for locator/i.test(rawMessage)) {
    return diagnosis("page_changed", true);
  }
  return diagnosis("runner_execution_failed", true, rootCause(error));
}
