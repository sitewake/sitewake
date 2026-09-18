import type { BrowserArtifact } from "./protocol";

const ALLOWED_CONTENT_TYPES: Record<BrowserArtifact["kind"], ReadonlySet<string>> = {
  screenshot: new Set(["image/jpeg", "image/png", "image/webp"]),
  video: new Set(["video/webm", "video/mp4"]),
  trace: new Set(["application/zip", "application/x-zip-compressed"]),
  dom: new Set(["application/json", "text/plain"]),
  console: new Set(["application/json", "text/plain"]),
};

export function browserArtifactContentType(kind: BrowserArtifact["kind"], value: string | undefined | null) {
  const normalized = value?.split(";", 1)[0]?.trim().toLowerCase() || "";
  if (!ALLOWED_CONTENT_TYPES[kind].has(normalized)) return undefined;
  return kind === "trace" ? "application/zip" : normalized;
}

export function browserArtifactDisposition(kind: BrowserArtifact["kind"]): "inline" | "attachment" {
  return kind === "screenshot" || kind === "video" ? "inline" : "attachment";
}

export function browserArtifactExtension(kind: BrowserArtifact["kind"], contentType: string) {
  if (kind === "trace") return ".zip";
  if (kind === "dom") return contentType === "application/json" ? ".json" : ".txt";
  if (kind === "console") return contentType === "application/json" ? ".json" : ".txt";
  if (contentType === "image/png") return ".png";
  if (contentType === "image/webp") return ".webp";
  if (contentType === "image/jpeg") return ".jpg";
  if (contentType === "video/mp4") return ".mp4";
  return ".webm";
}
