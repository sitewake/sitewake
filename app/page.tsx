import { cookies, headers } from "next/headers";
import { SiteAgentConsole } from "../components/site-agent-console";
import { configuredRunnerProjectionMode } from "../db/runner-control-store";
import { LOCALE_COOKIE_NAME, resolveServerLocale } from "../lib/i18n";

export default async function HomePage() {
  const runnerMode = configuredRunnerProjectionMode();
  // Same resolution as layout: the switcher in the console shell must receive the locale
  // the server already decided; inferring on its own would render a label inconsistent
  // with <html lang>.
  const [cookieStore, requestHeaders] = await Promise.all([cookies(), headers()]);
  const locale = resolveServerLocale({
    cookie: cookieStore.get(LOCALE_COOKIE_NAME)?.value,
    acceptLanguage: requestHeaders.get("accept-language"),
  });
  return <SiteAgentConsole initialRunnerMode={runnerMode} locale={locale} />;
}
