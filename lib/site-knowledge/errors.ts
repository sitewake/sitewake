/**
 * Stable errors shared by the Site Agent API and the browser console.
 *
 * The API must be able to distinguish authentication/resource failures from
 * storage and dependency failures.  The browser uses the same codes to turn a
 * response into an actionable message instead of collapsing every non-2xx
 * response into `site_agent_overview_failed`.
 */

import { t } from "../i18n";
export type SiteAgentErrorPhase =
  | "site_agent_lookup"
  | "site_agent_overview"
  | "site_agent_overview_database"
  | "site_agent_overview_runner"
  | "site_agent_episode";

export type SiteAgentDiagnostic = {
  code: string;
  phase: SiteAgentErrorPhase;
  message: string;
  retryable: boolean;
};

export class SiteAgentDataError extends Error {
  readonly code: string;
  readonly phase: SiteAgentErrorPhase;
  readonly status: number;
  readonly retryable: boolean;

  constructor(
    code: string,
    message: string,
    phase: SiteAgentErrorPhase,
    options: { status?: number; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message);
    this.name = "SiteAgentDataError";
    this.code = code;
    this.phase = phase;
    this.status = options.status ?? 503;
    this.retryable = options.retryable ?? this.status >= 500;
    if (options.cause !== undefined) {
      Object.defineProperty(this, "cause", {
        configurable: true,
        enumerable: false,
        value: options.cause,
        writable: false,
      });
    }
  }
}

type ErrorLike = {
  code?: unknown;
  message?: unknown;
  phase?: unknown;
  status?: unknown;
  retryable?: unknown;
};

function asErrorLike(error: unknown): ErrorLike {
  return error && typeof error === "object" ? error as ErrorLike : {};
}

function errorMessage(error: unknown) {
  const value = asErrorLike(error).message;
  return typeof value === "string" && value.trim() ? value.trim() : String(error || "unknown error");
}

function explicitCode(error: unknown) {
  const value = asErrorLike(error).code;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function looksLikeDatabaseFailure(code: string | undefined, message: string) {
  const value = `${code || ""} ${message}`.toLowerCase();
  return /database|d1|postgres|query|schema|sql|table|column|constraint|sqlite|connection|pool/.test(value);
}

function looksLikeRunnerFailure(code: string | undefined, message: string) {
  const value = `${code || ""} ${message}`.toLowerCase();
  // `pool` also appears in database connection-pool errors; do not turn those
  // storage failures into a Runner diagnostic unless the message identifies a
  // Runner/lease/queue/placement dependency explicitly.
  return /runner|lease|queue|placement/.test(value);
}

function fallbackMessage(code: string) {
  const messages = t().diagnostic;
  return messages[code as keyof typeof messages] || messages.site_agent_request_failed;
}

/**
 * Normalize a store/dependency exception for an API response or diagnostic.
 * Raw database messages are intentionally kept for server logs, while the
 * client receives a stable code and safe, actionable text.
 */
export function classifySiteAgentError(
  error: unknown,
  fallbackCode: "site_agent_lookup_failed" | "site_agent_overview_failed",
  fallbackPhase: SiteAgentErrorPhase,
): { code: string; status: number; phase: SiteAgentErrorPhase; message: string; retryable: boolean } {
  const typed = error instanceof SiteAgentDataError ? error : undefined;
  const rawCode = typed?.code || explicitCode(error);
  const rawMessage = errorMessage(error);

  if (typed) {
    return {
      code: typed.code,
      status: typed.status,
      phase: typed.phase,
      message: fallbackMessage(typed.code),
      retryable: typed.retryable,
    };
  }

  if (rawCode === "site_agent_not_found") {
    return { code: rawCode, status: 404, phase: fallbackPhase, message: t().diagnostic.site_agent_not_found, retryable: false };
  }
  if (rawCode === "site_agent_forbidden") {
    return { code: rawCode, status: 403, phase: fallbackPhase, message: t().diagnostic.site_agent_forbidden, retryable: false };
  }

  const runnerFailure = looksLikeRunnerFailure(rawCode, rawMessage)
    && (fallbackPhase === "site_agent_overview" || fallbackPhase === "site_agent_overview_runner");
  const databaseFailure = looksLikeDatabaseFailure(rawCode, rawMessage);
  const code = runnerFailure
    ? "site_agent_runner_service_failed"
    : databaseFailure
      ? "site_agent_database_failed"
      : fallbackCode;
  const phase = runnerFailure ? "site_agent_overview_runner" : databaseFailure ? "site_agent_overview_database" : fallbackPhase;
  return {
    code,
    status: code === fallbackCode ? 500 : 503,
    phase,
    message: fallbackMessage(code),
    retryable: true,
  };
}

/** Converts a response body into the message shown in the console. */
export function siteAgentClientErrorMessage(
  status: number,
  payload: unknown,
  resource: "list" | "overview" = "overview",
) {
  const body = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const code = typeof body.error === "string" ? body.error : "";
  const messages = t().diagnostic;
  if (status === 401 || code === "unauthorized") return messages.unauthorized;
  if (status === 403 || code === "site_agent_forbidden") return messages.site_agent_forbidden;
  if (status === 404 || code === "site_agent_not_found") return messages.site_agent_not_found_pick_again;
  if (code === "site_agent_runner_service_failed") return messages.site_agent_runner_service_failed;
  if (code === "site_agent_database_failed" || code === "site_agent_lookup_failed") return messages.site_agent_database_failed;
  if (code === "site_agent_episode_data_invalid") return messages.site_agent_episode_data_invalid;
  if (code === "site_agent_list_failed" && resource === "list") return messages.site_agent_list_failed;
  // A message the API chose to send wins: it is more specific than anything keyed here.
  if (typeof body.message === "string" && body.message.trim()) return body.message.trim();
  if (!status) return messages.console_unreachable;
  return resource === "list" ? messages.list_unavailable : messages.site_agent_overview_failed;
}

export function siteAgentDiagnosticFromError(error: unknown, fallbackCode: string, phase: SiteAgentErrorPhase): SiteAgentDiagnostic {
  const classified = classifySiteAgentError(
    error,
    fallbackCode === "site_agent_lookup_failed" ? "site_agent_lookup_failed" : "site_agent_overview_failed",
    phase,
  );
  return {
    code: classified.code,
    phase: classified.phase,
    message: classified.message,
    retryable: classified.retryable,
  };
}
