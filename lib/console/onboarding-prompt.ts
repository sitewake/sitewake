/**
 * The onboarding prompt handed to a coding IDE.
 *
 * Not copy but an instruction: the site id and SDK URL must come from the site the
 * server actually registered, and a few boundaries are fixed — assume no stack, ask for
 * no server secret, stop if the project is already bound to another site, and finally
 * report which files changed and how to undo. Drop one, and the IDE may quietly do
 * something the user never agreed to.
 *
 * Follows the console locale: users can only review what they are about to paste if
 * they can read it.
 */

import type { Locale } from "../i18n";

export type OnboardingPromptInput = {
  locale: Locale;
  /** The site URL, the one the server registered. */
  siteUrl: string;
  /** The site id. Not a secret. */
  siteAgentId: string;
  /** The console's own URL; the SDK loads from and handshakes back to it. */
  consoleOrigin: string;
};

function zh({ siteUrl, siteAgentId, consoleOrigin }: Omit<OnboardingPromptInput, "locale">) {
  return [
    `请在当前项目中接入 SiteWake 网站 Agent。`,
    ``,
    `接入信息：`,
    `- 网站地址：${siteUrl}`,
    `- SiteWake 接入标识：${siteAgentId}（已自动生成，保持原样即可）`,
    `- SDK 地址：${consoleOrigin}/sitewake.js`,
    ``,
    `请完成：`,
    `1. 先检查项目使用的框架、应用入口和全局布局文件，不要假设技术栈。`,
    `2. 选择适合当前项目的官方接入方式，让 SiteWake SDK 在所有业务页面加载。`,
    `3. 使用接入标识 ${siteAgentId}。它不是密钥，不要创建、请求或写入任何服务端密钥。`,
    `4. 如果项目已经绑定到另一个 SiteWake 网站，请停止并说明当前绑定，不要静默覆盖。`,
    `5. 保持现有页面功能和样式不变，不要改业务逻辑。`,
    `6. 启动或刷新网站，确认 ${siteUrl} 可访问，并检查浏览器控制台没有 SDK 加载错误。`,
    `7. 最后告诉我修改了哪些文件、为什么放在那里，以及如何撤销。`,
    ``,
    `验收标准：页面加载后能向 SiteWake 服务端发起站点握手；真正的来源域名和会话可信性由服务端验证，前端不得自行标记接入成功。`,
  ];
}

function en({ siteUrl, siteAgentId, consoleOrigin }: Omit<OnboardingPromptInput, "locale">) {
  return [
    `Please install the SiteWake site agent into this project.`,
    ``,
    `Details:`,
    `- Site address: ${siteUrl}`,
    `- SiteWake site identifier: ${siteAgentId} (already generated — leave it as is)`,
    `- SDK address: ${consoleOrigin}/sitewake.js`,
    ``,
    `Please do the following:`,
    `1. First inspect the framework, application entry point and global layout files. Do not assume the stack.`,
    `2. Use the official installation method that suits this project so the SiteWake SDK loads on every page.`,
    `3. Use the identifier ${siteAgentId}. It is not a secret — do not create, request or write any server-side secret.`,
    `4. If the project is already bound to a different SiteWake site, stop and describe the existing binding. Do not silently overwrite it.`,
    `5. Leave existing page behaviour and styling untouched. Do not change business logic.`,
    `6. Start or reload the site, confirm ${siteUrl} is reachable, and check the browser console for SDK loading errors.`,
    `7. Finally, tell me which files you changed, why you put it there, and how to undo it.`,
    ``,
    `Acceptance: once the page loads it can perform a site handshake against the SiteWake server. The real origin and session trustworthiness are verified server-side; the front end must never mark the install as successful on its own.`,
  ];
}

/** The prompt line by line. Rendered as is; the copy action joins with `\n`. */
export function onboardingPromptLines(input: OnboardingPromptInput): string[] {
  const { locale, ...rest } = input;
  return locale === "en" ? en(rest) : zh(rest);
}

export function onboardingPrompt(input: OnboardingPromptInput): string {
  return onboardingPromptLines(input).join("\n");
}
