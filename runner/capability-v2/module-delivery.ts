export function capabilityV2RuntimeEndpoints(environment: NodeJS.ProcessEnv = process.env) {
  const controlPlaneUrl = (environment.CAPABILITY_V2_CONTROL_PLANE_URL || "http://127.0.0.1:3000").trim().replace(/\/$/, "");
  const browserPublicUrl = environment.CAPABILITY_V2_BROWSER_PUBLIC_URL?.trim()
    || environment.SITEWAKE_PUBLIC_ORIGIN?.trim()
    || (environment.SITEWAKE_LOCAL_DEV === "1" && environment.NODE_ENV !== "production" ? controlPlaneUrl : undefined);
  return { controlPlaneUrl, browserPublicUrl };
}

type TerminalAuthoringError = Error & {
  code: string;
  authorRepairable: false;
  taskRetryable: boolean;
};

export class BrowserModuleUrlError extends Error {
  readonly code = "browser_module_url_invalid";
  readonly authorRepairable = false;
  readonly taskRetryable = true;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "BrowserModuleUrlError";
  }
}

export function isTerminalAuthoringError(error: unknown): error is TerminalAuthoringError {
  return error instanceof Error
    && typeof (error as Partial<TerminalAuthoringError>).code === "string"
    && (error as Partial<TerminalAuthoringError>).authorRepairable === false;
}

export function browserPublicBaseUrl(value: string | undefined) {
  const configured = value?.trim();
  if (!configured) return undefined;
  let parsed: URL;
  try { parsed = new URL(configured); }
  catch (cause) { throw new BrowserModuleUrlError("browser_module_url_invalid:public_url_parse_failed", { cause }); }
  if (!/^https?:$/.test(parsed.protocol)
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || !["", "/"].includes(parsed.pathname)) {
    throw new BrowserModuleUrlError("browser_module_url_invalid:public_url_must_be_http_origin");
  }
  return parsed.origin;
}

export function resolveCapabilityModuleUrl(moduleUrl: string, browserPublicUrl: string | undefined, expectedContentHash?: string) {
  const base = browserPublicBaseUrl(browserPublicUrl);
  if (!base) throw new BrowserModuleUrlError("browser_module_url_invalid:public_url_required");
  let resolved: URL;
  try { resolved = new URL(moduleUrl, `${base}/`); }
  catch (cause) { throw new BrowserModuleUrlError("browser_module_url_invalid:module_url_parse_failed", { cause }); }
  if (!/^https?:$/.test(resolved.protocol) || resolved.username || resolved.password || resolved.origin !== base) {
    throw new BrowserModuleUrlError("browser_module_url_invalid:module_url_must_use_public_origin");
  }
  if (!/^\/api\/capability-v2\/modules\/[a-f0-9]{64}$/i.test(resolved.pathname)) {
    throw new BrowserModuleUrlError("browser_module_url_invalid:module_path_or_hash_invalid");
  }
  const pathHash = resolved.pathname.split("/").at(-1)?.toLowerCase();
  if (expectedContentHash && pathHash !== expectedContentHash.toLowerCase()) {
    throw new BrowserModuleUrlError("browser_module_url_invalid:content_hash_mismatch");
  }
  return resolved.href;
}

export function assertBrowserModuleUrlForPage(pageUrl: string, moduleUrl: string) {
  let page: URL;
  let browserModule: URL;
  try {
    page = new URL(pageUrl);
    browserModule = new URL(moduleUrl);
  } catch (cause) {
    throw new BrowserModuleUrlError("browser_module_url_invalid:page_or_module_url_parse_failed", { cause });
  }
  if (page.protocol === "https:" && browserModule.protocol !== "https:") {
    throw new BrowserModuleUrlError("browser_module_url_invalid:https_page_requires_https_module");
  }
}
