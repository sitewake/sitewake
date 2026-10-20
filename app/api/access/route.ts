import {
  ACCESS_COOKIE_NAME,
  SESSION_TTL_MS,
  accessOnboardingSkipped,
  applyManagement,
  createSessionCookieValue,
  getAccessStatus,
  skipAccessOnboarding,
  verifyAccessPassword,
  type ManageAction,
} from "../../../lib/access-control";
import { siteAgentJson, siteAgentOptions } from "../site-agents/http";

export const runtime = "nodejs";

const MANAGE_ACTIONS: ManageAction[] = ["setPassword", "enable", "disable", "revokeSessions"];

function requestIsSecure(request: Request): boolean {
  const forwarded = request.headers.get("x-forwarded-proto");
  if (forwarded) return forwarded.split(",")[0].trim() === "https";
  return new URL(request.url).protocol === "https:";
}

function setSessionCookie(response: ReturnType<typeof siteAgentJson>, request: Request, value: string, maxAgeSeconds: number) {
  response.cookies.set(ACCESS_COOKIE_NAME, value, {
    httpOnly: true,
    sameSite: "lax",
    secure: requestIsSecure(request),
    path: "/",
    maxAge: maxAgeSeconds,
  });
}

// Public: the gate UI needs to know whether to prompt, but never sees secrets.
// `onboardingSkipped` travels with the status because the onboarding rail needs
// both facts to decide whether to show the password step at all, and asking for
// them separately would let the two answers come from different moments.
export async function GET() {
  const [status, onboardingSkipped] = await Promise.all([getAccessStatus(), accessOnboardingSkipped()]);
  return siteAgentJson({ ...status, onboardingSkipped, demoLock: process.env.SITEWAKE_DEMO_LOCK === "1" });
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { action?: string; password?: string };
  if (body.action === "logout") {
    const response = siteAgentJson({ ok: true, authenticated: false });
    setSessionCookie(response, request, "", 0);
    return response;
  }
  if (body.action === "skipOnboarding") {
    // Recording a skip needs no session: at this point the installation has no
    // password, so there is nobody to authenticate and nothing yet to protect.
    // It cannot be used to weaken a protected installation either — once a
    // password exists the step is already done and the flag is never read.
    await skipAccessOnboarding();
    return siteAgentJson({ ok: true, onboardingSkipped: true });
  }
  if (body.action !== "login") return siteAgentJson({ ok: false, error: "unknown_action" }, 400);
  const password = typeof body.password === "string" ? body.password : "";
  const result = await verifyAccessPassword(password);
  if (!result.ok || !result.sessionSecret) return siteAgentJson({ ok: false, error: "invalid_password" }, 401);
  const session = await createSessionCookieValue(result.sessionSecret, Date.now());
  const response = siteAgentJson({ ok: true, authenticated: true });
  setSessionCookie(response, request, session.value, Math.floor(SESSION_TTL_MS / 1000));
  return response;
}

export async function PUT(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    action?: ManageAction;
    password?: string;
    currentPassword?: string;
    adminKey?: string;
  };
  if (!body.action || !MANAGE_ACTIONS.includes(body.action)) return siteAgentJson({ ok: false, error: "unknown_action" }, 400);
  const result = await applyManagement(body.action, {
    password: body.password,
    currentPassword: body.currentPassword,
    adminKey: body.adminKey,
  });
  if (!result.ok) return siteAgentJson({ ok: false, error: result.error }, result.code);
  // `result.session` exists only on a setPassword, and carries no secret into
  // the body: the status is what the browser is told, the cookie is what it is
  // given.
  const response = siteAgentJson({ ok: true, status: result.status });
  if (result.session?.firstTime) {
    // A first password is set from an open console, by whoever is standing in
    // front of it. Rotating the secret here invalidates only that person's own
    // cookie, so clearing it would cost them a login in the middle of
    // onboarding and protect nobody. Sign them in instead; everyone arriving
    // afterwards needs the password.
    const session = await createSessionCookieValue(result.session.sessionSecret, Date.now());
    setSessionCookie(response, request, session.value, Math.floor(SESSION_TTL_MS / 1000));
  } else if (body.action === "setPassword" || body.action === "revokeSessions") {
    // Changing the password or revoking sessions invalidates every cookie
    // including the caller's; clear it so the browser re-authenticates against
    // the new secret.
    setSessionCookie(response, request, "", 0);
  }
  return response;
}

export function OPTIONS() {
  return siteAgentOptions();
}
