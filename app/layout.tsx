import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import { ACCESS_COOKIE_NAME, resolveAccessGate } from "../lib/access-control";
import { LOCALE_COOKIE_NAME, copy as localeCopy, resolveServerLocale } from "../lib/i18n";
import { AccessGate } from "../components/access-gate";
import "./globals.css";
import "./console-polish.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") || requestHeaders.get("host") || "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") || (host.startsWith("localhost") ? "http" : "https");
  const origin = `${protocol}://${host}`;
  // Tab titles and share cards are UI copy too. metadata is generated on the server with
  // the same locale resolution as the page — otherwise an English visitor's browser tab
  // would show a Chinese title.
  const meta = localeCopy(resolveServerLocale({
    cookie: (await cookies()).get(LOCALE_COOKIE_NAME)?.value,
    acceptLanguage: requestHeaders.get("accept-language"),
  })).shell.meta;
  const title = meta.title;
  const description = meta.description;
  return {
    metadataBase: new URL(origin),
    applicationName: "SiteWake",
    title: { default: title, template: "%s · SiteWake" },
    description,
    icons: { icon: "/brand/sitewake-mark.svg?v=wstar-1" },
    openGraph: { title, description, type: "website", url: origin, images: [{ url: `${origin}/og.png`, width: 1536, height: 1024, alt: meta.ogAlt }] },
    twitter: { card: "summary_large_image", title, description, images: [`${origin}/og.png`] },
  };
}

export default async function Layout({ children }: { children: React.ReactNode }) {
  // The gate only replaces rendered page content. It never covers `/api/*` or the
  // SDK `.js` entrypoints, which customer sites must reach without a password.
  const cookieStore = await cookies();
  const gate = await resolveAccessGate(cookieStore.get(ACCESS_COOKIE_NAME)?.value);
  // `<html lang>` is the console's single source of truth for language: resolved
  // here from the visitor's saved choice or their browser, then read back by
  // `t()` in the browser. Because both sides read the same attribute, the
  // server-rendered HTML and the hydrated tree can never disagree — which is
  // also why this is not resolved from localStorage or navigator.languages.
  const locale = resolveServerLocale({
    cookie: cookieStore.get(LOCALE_COOKIE_NAME)?.value,
    acceptLanguage: (await headers()).get("accept-language"),
  });
  return (
    <html lang={locale}>
      <body>
        {gate.locked ? <AccessGate locale={locale} /> : children}
      </body>
    </html>
  );
}
