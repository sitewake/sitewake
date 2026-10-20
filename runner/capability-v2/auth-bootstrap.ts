import type { BrowserContext, Locator, Page, Route } from "playwright";
import type { JsonObject, RunSpec } from "../../lib/capability-center-v2/model";
import { MissingInputError } from "./browser-runtime";

type AuthBootstrapConfig = {
  url?: string;
  usernameKey?: string;
  passwordKey?: string;
  otpKey?: string;
  usernameSelector?: string;
  passwordSelector?: string;
  otpSelector?: string;
  submitSelector?: string;
  successSelector?: string;
};

const guardedAuthContexts = new WeakMap<BrowserContext, string>();

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function configOf(spec: RunSpec): AuthBootstrapConfig {
  const raw = record(spec.input.context.authBootstrap);
  return {
    url: text(raw.url) || undefined,
    usernameKey: text(raw.usernameKey) || undefined,
    passwordKey: text(raw.passwordKey) || undefined,
    otpKey: text(raw.otpKey) || undefined,
    usernameSelector: text(raw.usernameSelector) || undefined,
    passwordSelector: text(raw.passwordSelector) || undefined,
    otpSelector: text(raw.otpSelector) || undefined,
    submitSelector: text(raw.submitSelector) || undefined,
    successSelector: text(raw.successSelector) || undefined,
  };
}

function safeSelector(value: string | undefined) {
  if (!value) return undefined;
  if (value.length > 500 || /[\r\n\0]/.test(value))
    throw new Error("auth_bootstrap_selector_invalid");
  return value;
}

async function firstVisible(
  root: Page | Locator,
  selectors: Array<string | undefined>,
) {
  for (const raw of selectors) {
    const selector = safeSelector(raw);
    if (!selector) continue;
    const candidates = root.locator(selector);
    const count = Math.min(await candidates.count(), 12);
    for (let index = 0; index < count; index += 1) {
      const candidate = candidates.nth(index);
      if (await candidate.isVisible().catch(() => false)) return candidate;
    }
  }
  return undefined;
}

function secret(spec: RunSpec, key: string) {
  const value = spec.resolvedSecrets?.[key];
  if (value === undefined || value === null || value === "")
    throw new MissingInputError(key, true);
  if (typeof value !== "string" && typeof value !== "number")
    throw new Error(`auth_secret_invalid:${key}`);
  return String(value);
}

function expectedAuthOrigin(spec: RunSpec, page: Page) {
  const contextStartUrl =
    typeof spec.input.context.startUrl === "string"
      ? spec.input.context.startUrl
      : undefined;
  const value = spec.browser.startUrl || contextStartUrl || page.url();
  const url = new URL(value);
  if (!/^https?:$/u.test(url.protocol))
    throw new Error("auth_bootstrap_url_invalid");
  return url.origin;
}

function assertAuthPageOrigin(page: Page, origin: string) {
  let current: URL;
  try {
    current = new URL(page.url());
  } catch {
    throw new Error("auth_bootstrap_url_invalid");
  }
  if (current.origin !== origin)
    throw new Error("auth_bootstrap_redirect_origin_invalid");
}

async function submit(
  page: Page,
  root: Page | Locator,
  configuredSelector: string | undefined,
  allowedOrigin: string,
) {
  const control = await firstVisible(root, [
    configuredSelector,
    'button[type="submit"]',
    'input[type="submit"]',
    'button:has-text("登录")',
    'button:has-text("继续")',
    'button:has-text("验证")',
    'button:has-text("Sign in")',
    'button:has-text("Log in")',
    'button:has-text("Continue")',
    'button:has-text("Verify")',
  ]);
  if (!control) throw new Error("auth_submit_control_not_found");
  const destination = await control.evaluate((element) => {
    const submitControl = element as HTMLButtonElement | HTMLInputElement;
    const form = submitControl.form || submitControl.closest("form");
    return form?.action || location.href;
  });
  if (new URL(destination, page.url()).origin !== allowedOrigin)
    throw new Error("auth_form_action_origin_invalid");
  const beforeUrl = page.url();
  await control.click();
  // waitForLoadState can resolve immediately for an already-loaded document.
  // Give same-page validation handlers one render turn, then wait for a new
  // document only when the submit actually changed the URL.
  await page.waitForTimeout(600);
  if (page.url() !== beforeUrl)
    await page
      .waitForLoadState("domcontentloaded", { timeout: 8_000 })
      .catch(() => undefined);
}

/**
 * Establishes login state without exposing credentials to the authoring model.
 * The optional task config only contains selectors and secret keys; actual
 * values live in RunSpec.resolvedSecrets for this authenticated Runner call.
 */
export async function bootstrapAuthentication(
  page: Page,
  spec: RunSpec,
  onEvent?: (
    phase: string,
    message: string,
    payload?: JsonObject,
  ) => Promise<void> | void,
) {
  const config = configOf(spec);
  const allowedOrigin = expectedAuthOrigin(spec, page);
  const context = page.context();
  const existingGuardOrigin = guardedAuthContexts.get(context);
  if (existingGuardOrigin && existingGuardOrigin !== allowedOrigin)
    throw new Error("auth_bootstrap_origin_changed");
  if (!existingGuardOrigin) {
    const authRequestGuard = async (route: Route) => {
      let allowed = false;
      try {
        allowed = new URL(route.request().url()).origin === allowedOrigin;
      } catch {
        allowed = false;
      }
      if (allowed) await route.continue();
      else await route.abort("blockedbyclient");
    };
    await context.route("**/*", authRequestGuard);
    await context.routeWebSocket("**/*", (socket) => {
      let allowed = false;
      try {
        allowed = new URL(socket.url()).origin === allowedOrigin;
      } catch {
        allowed = false;
      }
      if (allowed) socket.connectToServer();
      else socket.close();
    });
    guardedAuthContexts.set(context, allowedOrigin);
  }

  const requestedUrl =
    config.url ||
    spec.browser.startUrl ||
    (typeof spec.input.context.startUrl === "string"
      ? spec.input.context.startUrl
      : undefined);
  if (requestedUrl) {
    const authUrl = new URL(requestedUrl);
    if (
      !/^https?:$/u.test(authUrl.protocol) ||
      authUrl.origin !== allowedOrigin ||
      authUrl.username ||
      authUrl.password
    )
      throw new Error("auth_bootstrap_url_invalid");
    if (page.url() !== authUrl.href)
      await page.goto(authUrl.href, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
  }
  await onEvent?.("AuthBootstrap", "checking sign-in state");

  const password = await firstVisible(page, [
    config.passwordSelector,
    'input[type="password"]',
    'input[autocomplete="current-password"]',
    'input[autocomplete="new-password"]',
  ]);
  let authenticated = false;
  if (password) {
    assertAuthPageOrigin(page, allowedOrigin);
    const form = (await password.locator("xpath=ancestor::form[1]").count())
      ? password.locator("xpath=ancestor::form[1]")
      : page;
    const username = await firstVisible(form, [
      config.usernameSelector,
      'input[autocomplete="username"]',
      'input[type="email"]',
      'input[name*="user" i]',
      'input[name*="email" i]',
      'input[type="text"]',
    ]);
    const usernameKey = config.usernameKey || "username";
    const passwordKey = config.passwordKey || "password";
    // Resolve every required value before mutating the page so WaitingInput can
    // resume from the exact same clean login form.
    const usernameValue = username ? secret(spec, usernameKey) : undefined;
    const passwordValue = secret(spec, passwordKey);
    await onEvent?.("AuthBootstrap", "signing in with protected input", {
      fields: username ? [usernameKey, passwordKey] : [passwordKey],
    });
    if (username && usernameValue !== undefined)
      await username.fill(usernameValue);
    await password.fill(passwordValue);
    await submit(page, form, config.submitSelector, allowedOrigin);
    assertAuthPageOrigin(page, allowedOrigin);
    authenticated = true;
  }

  const otp = await firstVisible(page, [
    config.otpSelector,
    'input[autocomplete="one-time-code"]',
    'input[name*="otp" i]',
    'input[name*="verification" i]',
    'input[name*="code" i]',
  ]);
  if (otp) {
    assertAuthPageOrigin(page, allowedOrigin);
    const form = (await otp.locator("xpath=ancestor::form[1]").count())
      ? otp.locator("xpath=ancestor::form[1]")
      : page;
    const otpKey = config.otpKey || "otp";
    const otpValue = secret(spec, otpKey);
    await onEvent?.("AuthBootstrap", "submitting one-time verification", {
      fields: [otpKey],
    });
    await otp.fill(otpValue);
    await submit(page, form, config.submitSelector, allowedOrigin);
    assertAuthPageOrigin(page, allowedOrigin);
    authenticated = true;
  }

  if (config.successSelector) {
    const success = await firstVisible(page, [config.successSelector]);
    if (!success) throw new Error("auth_success_condition_missing");
  } else {
    const remainingPassword = await firstVisible(page, [
      config.passwordSelector,
      'input[type="password"]',
    ]);
    if (authenticated && remainingPassword)
      throw new Error("authentication_failed");
  }
  await onEvent?.(
    "AuthBootstrap",
    authenticated ? "signed in" : "no sign-in needed",
  );
  return { authenticated };
}
