import type { CapabilityPromptProvenance } from "./model";

export type VersionedPrompt = {
  key: string;
  version: string;
  text: string;
  outputSchema: {
    name: string;
    description?: string;
    strict?: boolean;
    schema: Record<string, unknown>;
  };
};

export async function promptHash(prompt: Pick<VersionedPrompt, "key" | "version" | "text" | "outputSchema">) {
  const canonical = JSON.stringify({
    key: prompt.key,
    version: prompt.version,
    text: prompt.text,
    outputSchema: prompt.outputSchema,
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function promptProvenance(prompt: VersionedPrompt, model: string): Promise<CapabilityPromptProvenance> {
  return {
    promptKey: prompt.key,
    promptVersion: prompt.version,
    promptHash: await promptHash(prompt),
    model,
  };
}
