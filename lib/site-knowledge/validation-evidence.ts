import type { BrowserArtifact, JsonValue } from "./protocol";

export type ValidationArtifactRole =
  | "before-screenshot"
  | "after-screenshot"
  | "keyframe"
  | "validation-video"
  | "trace";

export const validationArtifactLabels: Record<ValidationArtifactRole, string> = {
  "before-screenshot": "[before-screenshot] 验证执行前截图",
  "after-screenshot": "[after-screenshot] 验证执行后截图",
  keyframe: "[keyframe] 验证过程关键帧",
  "validation-video": "[validation-video] 独立验证录屏",
  trace: "[trace] 浏览器执行 Trace",
};

export function validationArtifactRole(artifact: Pick<BrowserArtifact, "kind" | "label" | "role">): ValidationArtifactRole | undefined {
  if (artifact.role === "before-screenshot" || artifact.role === "after-screenshot" || artifact.role === "keyframe" || artifact.role === "validation-video" || artifact.role === "trace") return artifact.role;
  const role = artifact.label.match(/^\[([^\]]+)\]/)?.[1];
  if (role === "before-screenshot" || role === "after-screenshot" || role === "keyframe" || role === "validation-video" || role === "trace") return role;
  return artifact.kind === "video" && artifact.label.includes("独立验证") ? "validation-video" : undefined;
}

export function validationArtifactEvidence(artifacts: BrowserArtifact[]): JsonValue[] {
  return artifacts.flatMap((artifact) => {
    const role = validationArtifactRole(artifact);
    return role ? [{ artifactId: artifact.id, kind: artifact.kind, label: artifact.label, role }] : [];
  });
}
