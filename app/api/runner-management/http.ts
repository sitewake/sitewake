import { NextResponse } from "next/server";
import { ACCESS_COOKIE_NAME, resolveAccessGate } from "../../../lib/access-control";

const MANAGEMENT_HEADERS = {
  "cache-control": "no-store",
  "cdn-cache-control": "no-store",
  "cloudflare-cdn-cache-control": "no-store",
  vary: "cookie",
};

function requestCookie(request: Request, name: string) {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    const value = part.slice(separator + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return undefined;
}

/**
 * Runner management follows the same boundary as the open-source console:
 * when the access gate is disabled the console is open, and when it is enabled
 * the request must carry the same signed session cookie as the rendered UI.
 */
export async function runnerManagementAuthorized(request: Request) {
  const gate = await resolveAccessGate(requestCookie(request, ACCESS_COOKIE_NAME));
  return !gate.locked && !gate.unavailable;
}

export function runnerManagementJson(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: MANAGEMENT_HEADERS });
}
