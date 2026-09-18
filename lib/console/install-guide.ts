/**
 * The single source of the install snippet.
 *
 * All four tabs use the same SDK tag; they differ only in which file it goes in and
 * how that framework writes it. Copy (where, why) stays in the dictionary keyed by
 * stack; this only produces structure and code, so the Chinese and English versions
 * cannot drift by each assembling their own.
 *
 * Escaping applies only to interpolated values (control-plane URL and site id); the
 * skeleton is code shown as is.
 */

export type InstallStack = "html" | "react" | "next" | "vue";

/** Tab identities and order. The renderer takes copy from the dictionary by id. */
export const INSTALL_STACKS: InstallStack[] = ["html", "react", "next", "vue"];

export type InstallGuide = {
  stack: InstallStack;
  /** Display code, line by line, rendered as is. */
  lines: string[];
  /** Text copied to the clipboard. */
  plain: string;
};

function escape(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function parts(origin: string, siteId: string) {
  return { base: escape(new URL(origin).origin), id: escape(siteId) };
}

/** The line pasted straight into HTML — shared by the HTML, React and Vue tabs. */
function scriptTag(origin: string, siteId: string) {
  const { base, id } = parts(origin, siteId);
  return `<script src="${base}/sitewake.js" data-site-agent="${id}" data-endpoint="${base}" defer></script>`;
}

/**
 * The install snippet for one site on one stack.
 *
 * Next.js gets its own: a raw `<script>` in an App Router layout is dropped by React,
 * so the framework's script component is required. That is the real reason four tabs exist.
 */
export function installGuide(origin: string, siteId: string, stack: InstallStack): InstallGuide {
  if (stack === "next") {
    const { base, id } = parts(origin, siteId);
    const lines = [
      `import Script from "next/script";`,
      ``,
      `<Script`,
      `  src="${base}/sitewake.js"`,
      `  data-site-agent="${id}"`,
      `  data-endpoint="${base}"`,
      `/>`,
    ];
    return { stack, lines, plain: lines.join("\n") };
  }
  const tag = scriptTag(origin, siteId);
  return { stack, lines: [tag], plain: tag };
}

/**
 * The snippet shown on the connection settings page is the HTML tab's code. The name
 * is kept because that page already uses it, and "install snippet" in that context
 * means the paste-ready HTML form.
 */
export function installationSnippet(origin: string, siteId: string) {
  return installGuide(origin, siteId, "html").plain;
}
