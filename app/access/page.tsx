import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import { AccessManagePanel } from "../../components/access-manage-panel";
import { LOCALE_COOKIE_NAME, copy as localeCopy, resolveServerLocale } from "../../lib/i18n";

/**
 * The locale is resolved here rather than read from `<html lang>`: metadata is
 * produced before any document exists, and this page renders on the server.
 */
async function pageLocale() {
  const [cookieStore, headerStore] = await Promise.all([cookies(), headers()]);
  return resolveServerLocale({
    cookie: cookieStore.get(LOCALE_COOKIE_NAME)?.value,
    acceptLanguage: headerStore.get("accept-language"),
  });
}

export async function generateMetadata(): Promise<Metadata> {
  return {
    title: localeCopy(await pageLocale()).shell.accessPage.title,
    robots: { index: false, follow: false },
  };
}

export default async function AccessManagePage() {
  const locale = await pageLocale();
  const copy = localeCopy(locale).shell.accessPage;
  return (
    <main className="sw-access-page">
      <div className="sw-access-card">
        <h1>{copy.title}</h1>
        <p>{copy.body}</p>
        <AccessManagePanel locale={locale} showLogout />
      </div>
    </main>
  );
}
