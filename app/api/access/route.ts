import {
  ACCESS_COOKIE_NAME,
  SESSION_TTL_MS,
  applyManagement,
  createSessionCookieValue,
  getAccessStatus,
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
export async function GET() {
  return siteAgentJson(await getAccessStatus());
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { action?: string; password?: string };
  if (body.action === "logout") {
    const response = siteAgentJson({ ok: true, authenticated: false });
    setSessionCookie(response, request, "", 0);
    return response;
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
  const response = siteAgentJson({ ok: true, status: result.status });
  // Changing the password or revoking sessions invalidates the caller's own
  // cookie; clear it so the browser re-authenticates against the new secret.
  if (body.action === "setPassword" || body.action === "revokeSessions") setSessionCookie(response, request, "", 0);
  return response;
}

export function OPTIONS() {
  return siteAgentOptions();
}
