import type {
  AgentRunActivity,
  AgentRunCheckpoint,
  ElementEvidence,
  JsonValue,
  OutcomeReceipt,
  PageExecutionBrief,
  PageSnapshot,
  StableTargetRef,
  TaskEpisode,
} from "./protocol";

const SENSITIVE_FIELD = /(?:password|passwd|passcode|secret|credential|authorization|bearer|cookie|api.?key|access.?token|refresh.?token|auth.?token|token|session(?:id)?|one.?time|otp|totp|credit.?card|debit.?card|card.?(?:number|no|security|expiry|expiration)|cc.?(?:number|num|csc|exp)|cvc|cvv|cvn)/iu;
const CARD_CANDIDATE = /(?:\d[ -]?){13,19}/gu;
const CVC_ASSIGNMENT = /\b(cvc|cvv|cvn|card[\s_-]*security[\s_-]*code)(\s*[:=]\s*)(\d{3,4})\b/giu;
const SENSITIVE_ASSIGNMENT = /\b(password|passwd|passcode|secret|credential|authorization|bearer|cookie|api[-_\s]?key|access[-_\s]?token|refresh[-_\s]?token|auth[-_\s]?token|token|session(?:id)?|one[-_\s]?time(?:[-_\s]?code)?|otp|totp)(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s<>&,;]+)/giu;
const REDACTED = "[REDACTED]";
const SENSITIVE_AUTOCOMPLETE = /(?:current-password|new-password|one-time-code|cc-number|cc-csc|cc-exp|cc-exp-month|cc-exp-year)/iu;

function validPan(candidate: string) {
  const digits = candidate.replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19 || /^(\d)\1+$/u.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let value = Number(digits[index]);
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }
  return sum % 10 === 0;
}

export function redactSensitiveText(value: string) {
  return value
    .replace(SENSITIVE_ASSIGNMENT, (_match, label: string, separator: string) => `${label}${separator}${REDACTED}`)
    .replace(CVC_ASSIGNMENT, (_match, label: string, separator: string) => `${label}${separator}${REDACTED}`)
    .replace(CARD_CANDIDATE, (candidate) => validPan(candidate) ? REDACTED : candidate);
}

function sensitiveControlTag(tag: string) {
  return /\btype\s*=\s*["']?password\b/iu.test(tag)
    || new RegExp(`\\bautocomplete\\s*=\\s*["']?[^\\s>]*${SENSITIVE_AUTOCOMPLETE.source}`, "iu").test(tag)
    || Array.from(tag.matchAll(/\b(?:name|id|aria-label|placeholder)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/giu))
      .some((match) => SENSITIVE_FIELD.test(match[1] || match[2] || match[3] || ""));
}

function redactControlValue(tag: string) {
  return tag.replace(
    /(\bvalue\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s>]+)/giu,
    `$1${REDACTED}`,
  );
}

/** Sanitizes model-visible page text, including serialized sensitive controls. */
export function redactSensitivePageText(value: string) {
  return redactSensitiveText(value)
    .replace(/<input\b[^>]*>/giu, (tag) => sensitiveControlTag(tag) ? redactControlValue(tag) : tag)
    .replace(/<textarea\b[^>]*>[\s\S]*?<\/textarea\s*>/giu, (control) => {
      const opening = control.match(/^<textarea\b[^>]*>/iu)?.[0] || "";
      if (!sensitiveControlTag(opening)) return control;
      return `${redactControlValue(opening)}${REDACTED}</textarea>`;
    });
}

/** URL sanitizer shared by browser projection and server-side evidence ingress. */
export function redactSensitiveUrl(value: string) {
  try {
    const url = new URL(value, "https://page-agent.invalid");
    if (url.username || url.password) {
      url.username = REDACTED;
      url.password = REDACTED;
    }
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_FIELD.test(key)) url.searchParams.set(key, REDACTED);
      else url.searchParams.set(key, redactSensitiveText(url.searchParams.get(key) || ""));
    }
    url.hash = redactSensitiveText(url.hash);
    return /^https?:/iu.test(value) ? url.toString() : `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return redactSensitiveText(value);
  }
}

export function redactSensitiveJson(value: JsonValue, key = "", depth = 0): JsonValue {
  if (depth > 10) return "[TRUNCATED]";
  if (SENSITIVE_FIELD.test(key)) return REDACTED;
  if (typeof value === "string") return redactSensitiveText(value);
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (Array.isArray(value)) return value.map((item) => redactSensitiveJson(item, key, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([childKey, item]) => [
    childKey,
    redactSensitiveJson(item, childKey, depth + 1),
  ]));
}

function sanitizeElement(element: ElementEvidence): ElementEvidence {
  const descriptor = [element.tag, element.role, element.accessibleName, element.label,
    element.placeholder, element.name, JSON.stringify(element.attributes)].join(" ");
  const sensitive = SENSITIVE_FIELD.test(descriptor)
    || SENSITIVE_AUTOCOMPLETE.test(String(element.attributes?.autocomplete || ""))
    || String(element.attributes?.type || "").toLowerCase() === "password";
  return {
    ...element,
    text: element.text === undefined ? undefined : sensitive ? REDACTED : redactSensitivePageText(element.text),
    role: element.role === undefined ? undefined : redactSensitivePageText(element.role),
    accessibleName: element.accessibleName === undefined ? undefined : redactSensitivePageText(element.accessibleName),
    label: element.label === undefined ? undefined : redactSensitivePageText(element.label),
    placeholder: element.placeholder === undefined ? undefined : redactSensitivePageText(element.placeholder),
    name: element.name === undefined ? undefined : redactSensitivePageText(element.name),
    href: element.href === undefined ? undefined : redactSensitiveUrl(element.href),
    attributes: Object.fromEntries(Object.entries(element.attributes || {}).map(([key, item]) => [
      key,
      sensitive && /^(?:value|data-value)$/iu.test(key)
        ? REDACTED
        : SENSITIVE_FIELD.test(key) ? REDACTED : redactSensitivePageText(item),
    ])),
    contextText: element.contextText === undefined ? undefined : redactSensitivePageText(element.contextText),
    cssPath: element.cssPath === undefined ? undefined : redactSensitivePageText(element.cssPath),
  };
}

export function sanitizePageSnapshot(snapshot: PageSnapshot): PageSnapshot {
  return {
    ...snapshot,
    url: redactSensitiveUrl(snapshot.url),
    title: redactSensitivePageText(snapshot.title),
    heading: redactSensitivePageText(snapshot.heading),
    visibleText: redactSensitivePageText(snapshot.visibleText),
    links: snapshot.links.map((link) => ({ text: redactSensitivePageText(link.text), url: redactSensitiveUrl(link.url) })),
    elements: snapshot.elements?.map(sanitizeElement),
    metadata: snapshot.metadata ? Object.fromEntries(Object.entries(snapshot.metadata).map(([key, item]) => {
      if (item === undefined) return [key, item];
      if (Array.isArray(item)) return [key, item.map((value) => redactSensitivePageText(value))];
      return [key, /url$/iu.test(key) ? redactSensitiveUrl(item) : redactSensitivePageText(item)];
    })) as PageSnapshot["metadata"] : undefined,
  };
}

function sanitizeStableTarget(target: StableTargetRef): StableTargetRef {
  return {
    ...target,
    role: target.role === undefined ? undefined : redactSensitivePageText(target.role),
    accessibleName: target.accessibleName === undefined ? undefined : redactSensitivePageText(target.accessibleName),
    controlType: target.controlType === undefined ? undefined : redactSensitivePageText(target.controlType),
    formSignature: target.formSignature === undefined ? undefined : redactSensitivePageText(target.formSignature),
    hrefPath: target.hrefPath === undefined ? undefined : redactSensitiveUrl(target.hrefPath),
    nearbyText: target.nearbyText === undefined ? undefined : redactSensitivePageText(target.nearbyText),
  };
}

export function sanitizeOutcomeReceipt(outcome: OutcomeReceipt): OutcomeReceipt {
  return {
    ...outcome,
    summary: redactSensitivePageText(outcome.summary),
    evidence: redactSensitiveJson(outcome.evidence) as Record<string, JsonValue>,
  };
}

function sanitizePageExecutionBrief(brief: PageExecutionBrief): PageExecutionBrief {
  return {
    ...brief,
    objective: redactSensitivePageText(brief.objective),
    normalizedGoal: redactSensitivePageText(brief.normalizedGoal),
    entities: redactSensitiveJson(brief.entities) as Record<string, JsonValue>,
    completionCriteria: brief.completionCriteria.map(redactSensitivePageText),
    rejectedCapabilityReasons: brief.rejectedCapabilityReasons.map(redactSensitivePageText),
  };
}

export function sanitizeAgentRunActivity(activity: AgentRunActivity): AgentRunActivity {
  return {
    ...activity,
    label: redactSensitivePageText(activity.label),
    detail: activity.detail === undefined ? undefined : redactSensitivePageText(activity.detail),
    capabilityName: activity.capabilityName === undefined ? undefined : redactSensitivePageText(activity.capabilityName),
    input: activity.input === undefined ? undefined : redactSensitiveJson(activity.input) as Record<string, JsonValue>,
    output: activity.output === undefined ? undefined : redactSensitiveJson(activity.output) as Record<string, JsonValue>,
    operationName: activity.operationName === undefined ? undefined : redactSensitivePageText(activity.operationName),
    url: activity.url === undefined ? undefined : redactSensitiveUrl(activity.url),
  };
}

const STRUCTURAL_CHECKPOINT_KEY = /^(?:id|.*Id|.*Ids|.*Hash|sha256|schemaVersion|mode|phase|kind|status|action|op|effect|source|startedAt|endedAt|createdAt|updatedAt|capturedAt|expiresAt|savedAt)$/u;

function sanitizeCheckpointValue(value: JsonValue, key = "", depth = 0): JsonValue {
  if (depth > 16) return "[TRUNCATED]";
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    if (STRUCTURAL_CHECKPOINT_KEY.test(key)) return value;
    return /url$/iu.test(key) ? redactSensitiveUrl(value) : redactSensitivePageText(value);
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeCheckpointValue(item, key, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([childKey, item]) => {
    if (["input", "output", "bindings", "entities"].includes(childKey)) {
      return [childKey, redactSensitiveJson(item, childKey, depth + 1)];
    }
    return [childKey, sanitizeCheckpointValue(item, childKey, depth + 1)];
  }));
}

/** Preserve resumability identifiers while sanitizing all detachable content. */
export function sanitizeAgentRunCheckpoint(checkpoint: AgentRunCheckpoint): AgentRunCheckpoint {
  const sanitized = sanitizeCheckpointValue(checkpoint as unknown as JsonValue) as unknown as AgentRunCheckpoint;
  return {
    ...sanitized,
    input: redactSensitiveJson(checkpoint.input) as Record<string, JsonValue>,
    output: redactSensitiveJson(checkpoint.output) as Record<string, JsonValue>,
    activityTimeline: checkpoint.activityTimeline?.map(sanitizeAgentRunActivity),
  };
}

/** Schema-aware Episode sanitizer. Identity, hashes and evidence references stay exact. */
export function sanitizeTaskEpisode(episode: TaskEpisode): TaskEpisode {
  return {
    ...episode,
    goal: redactSensitivePageText(episode.goal),
    normalizedGoal: redactSensitivePageText(episode.normalizedGoal),
    input: redactSensitiveJson(episode.input) as Record<string, JsonValue>,
    pageExecutionBrief: episode.pageExecutionBrief ? sanitizePageExecutionBrief(episode.pageExecutionBrief) : undefined,
    startSnapshot: sanitizePageSnapshot(episode.startSnapshot),
    endSnapshot: sanitizePageSnapshot(episode.endSnapshot),
    transitions: episode.transitions.map((transition) => ({
      ...transition,
      fromSnapshot: transition.fromSnapshot ? sanitizePageSnapshot(transition.fromSnapshot) : undefined,
      toSnapshot: transition.toSnapshot ? sanitizePageSnapshot(transition.toSnapshot) : undefined,
      elementEvidence: transition.elementEvidence.map(sanitizeElement),
      inputBindings: redactSensitiveJson(transition.inputBindings) as Record<string, JsonValue>,
      outputBindings: redactSensitiveJson(transition.outputBindings) as Record<string, JsonValue>,
      outcome: transition.outcome ? sanitizeOutcomeReceipt(transition.outcome) : undefined,
    })),
    outcome: sanitizeOutcomeReceipt(episode.outcome),
    experience: episode.experience ? {
      ...episode.experience,
      actions: episode.experience.actions.map((action) => ({
        ...action,
        input: redactSensitiveJson(action.input) as Record<string, JsonValue>,
        element: action.element ? sanitizeElement(action.element) : undefined,
        page: {
          ...action.page,
          url: redactSensitiveUrl(action.page.url),
          title: redactSensitivePageText(action.page.title),
          heading: redactSensitivePageText(action.page.heading),
        },
      })),
      routes: episode.experience.routes?.map((item) => ({
        ...item,
        url: redactSensitiveUrl(item.url),
        bindings: redactSensitiveJson(item.bindings) as Record<string, JsonValue>,
      })),
      actorSummary: redactSensitivePageText(episode.experience.actorSummary),
      judgeEvidence: episode.experience.judgeEvidence.map(redactSensitivePageText),
      actionReceiptsV2: episode.experience.actionReceiptsV2?.map((receipt) => ({
        ...receipt,
        target: receipt.target ? sanitizeStableTarget(receipt.target) : undefined,
        input: redactSensitiveJson(receipt.input) as Record<string, JsonValue>,
        effectSignals: redactSensitiveJson(receipt.effectSignals) as Record<string, JsonValue>,
      })),
      runtimeMetrics: episode.experience.runtimeMetrics?.map((metric) => ({
        ...metric,
        detail: metric.detail === undefined ? undefined : redactSensitiveJson(metric.detail) as Record<string, JsonValue>,
      })),
      toolReceipts: episode.experience.toolReceipts?.map((receipt) => ({
        ...receipt,
        name: redactSensitivePageText(receipt.name),
        summary: redactSensitivePageText(receipt.summary),
        output: receipt.output === undefined ? undefined : redactSensitiveJson(receipt.output) as Record<string, JsonValue>,
      })),
    } : undefined,
  };
}
