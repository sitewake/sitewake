import type { KnowledgeCandidate, SceneDefinition } from "./protocol";

const words = (value: string) => new Set(String(value || "").toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || []);
const overlap = (left: string, right: string) => {
  const a = words(left);
  const b = words(right);
  let score = 0;
  for (const value of a) if (b.has(value) || [...b].some((item) => item.includes(value) || value.includes(item))) score += 1;
  return score;
};

function planForScene(candidate: KnowledgeCandidate, scene: SceneDefinition) {
  if (scene.directEntry !== "verified") return undefined;
  const template = scene.urlTemplates[0];
  if (!template) return undefined;
  const inputs = Object.entries(candidate.capability.inputs.properties || {});
  const mappings = scene.parameters.flatMap((parameter) => {
    const match = inputs
      .map(([id, schema]) => ({ id, score: id === parameter.id ? 10 : overlap(`${schema.description || ""} ${id}`, `${parameter.name} ${parameter.id}`) }))
      .sort((a, b) => b.score - a.score)[0];
    return match?.score ? [{ parameterId: parameter.id, inputId: match.id }] : [];
  });
  const mappedInputs = new Set(mappings.map((item) => item.inputId));
  if ((candidate.capability.inputs.required || []).some((id) => !mappedInputs.has(id))) return undefined;
  const textScore = overlap(`${candidate.capability.name} ${candidate.capability.description}`, `${scene.name} ${scene.description || ""}`);
  return { scene, template, mappings, score: textScore + mappings.length * 4 };
}

/**
 * Compile an already verified direct entry into a small two-stage capability.
 * This is the reliable fast path for history that already contains enough
 * structural knowledge; Codex remains the fallback for novel page behavior.
 */
export function compileVerifiedEntryCapability(candidate: KnowledgeCandidate) {
  const selected = candidate.scenes.map((scene) => planForScene(candidate, scene)).filter(Boolean).sort((a, b) => b!.score - a!.score)[0];
  if (!selected || selected.score <= 0) return undefined;
  const plan = {
    origin: selected.template.originPattern,
    pathname: selected.template.pathnamePattern,
    query: Object.keys(selected.template.query || {}).flatMap((key) => {
      const parameterId = String(selected.template.query?.[key] || "").replace(/[{}?]/g, "") || key;
      const mapping = selected.mappings.find((item) => item.parameterId === parameterId);
      return mapping ? [{ key, inputId: mapping.inputId }] : [];
    }),
    paths: selected.mappings.filter((item) => selected.template.pathnamePattern.includes(`{${item.parameterId}}`)),
  };
  const serialized = JSON.stringify(plan);
  return `// Compiled from a verified website entry; no sample value is embedded.
export const capability = {
  version: 1,
  stages: [
    {
      id: "open-verified-entry",
      async run({ input }) {
        const plan = ${serialized};
        let pathname = plan.pathname;
        for (const binding of plan.paths) pathname = pathname.replace(\`{\${binding.parameterId}}\`, encodeURIComponent(String(input[binding.inputId] ?? "")));
        const url = new URL(pathname, plan.origin);
        for (const binding of plan.query) url.searchParams.set(binding.key, String(input[binding.inputId] ?? ""));
        if (location.href !== url.href) location.href = url.href;
        return { state: { expectedUrl: url.href } };
      },
    },
    {
      id: "read-business-results",
      async run() {
        const root = document.querySelector("main") || document.body;
        const primary = [...root.querySelectorAll("tbody tr, article, [role=listitem], li")];
        const fallback = [...root.querySelectorAll("a[href]")];
        const nodes = primary.length ? primary : fallback;
        const items = nodes.map((node) => {
          const text = (node.textContent || "").replace(/\\s+/g, " ").trim();
          const anchor = node.matches("a[href]") ? node : node.querySelector("a[href]");
          return { text, href: anchor?.href || "" };
        }).filter((item) => item.text.length > 1).slice(0, 100);
        const countText = (root.textContent || "").match(/(?:共|找到)\\s*(\\d+)\\s*(?:条|个)/);
        return { output: {
          items,
          totalCount: countText ? Number(countText[1]) : items.length,
          pageUrl: location.href,
          pageTitle: document.title,
        } };
      },
    },
  ],
};
`;
}
