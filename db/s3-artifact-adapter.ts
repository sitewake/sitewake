import { createHash, createHmac } from "node:crypto";
import type { R2BucketLike, R2ObjectLike } from "./index";

function sha256(value: Uint8Array | string) { return createHash("sha256").update(value).digest("hex"); }
function hmac(key: Uint8Array | string, value: string) { return createHmac("sha256", key).update(value).digest(); }
function objectPath(bucket: string, key: string) { return `/${encodeURIComponent(bucket)}/${key.split("/").map(encodeURIComponent).join("/")}`; }

export function createS3ArtifactAdapter(): R2BucketLike {
  const endpoint = new URL(process.env.S3_ENDPOINT!);
  const bucket = process.env.S3_BUCKET!;
  const region = process.env.S3_REGION || "us-east-1";
  const accessKey = process.env.S3_ACCESS_KEY_ID || "";
  const secretKey = process.env.S3_SECRET_ACCESS_KEY || "";
  async function request(method: string, key: string, body?: Uint8Array, contentType?: string) {
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
    const date = amzDate.slice(0, 8);
    const path = objectPath(bucket, key);
    const bodyHash = sha256(body || new Uint8Array());
    const headers: Record<string, string> = { host: endpoint.host, "x-amz-content-sha256": bodyHash, "x-amz-date": amzDate };
    if (contentType) headers["content-type"] = contentType;
    const names = Object.keys(headers).sort();
    const canonicalHeaders = names.map((name) => `${name}:${headers[name].trim()}\n`).join("");
    const canonicalRequest = [method, path, "", canonicalHeaders, names.join(";"), bodyHash].join("\n");
    const scope = `${date}/${region}/s3/aws4_request`;
    const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256(canonicalRequest)}`;
    const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretKey}`, date), region), "s3"), "aws4_request");
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${names.join(";")}, Signature=${createHmac("sha256", signingKey).update(stringToSign).digest("hex")}`;
    return fetch(new URL(path, endpoint), { method, headers, body: body && method !== "GET" ? (body as BodyInit) : undefined });
  }
  return {
    async put(key, value, options) {
      const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(await new Response(value).arrayBuffer());
      const response = await request("PUT", key, bytes, options?.httpMetadata?.contentType);
      if (!response.ok) throw new Error(`s3_put_failed:${response.status}:${await response.text()}`);
    },
    async get(key): Promise<R2ObjectLike | null> {
      const response = await request("GET", key);
      if (response.status === 404) return null;
      if (!response.ok || !response.body) throw new Error(`s3_get_failed:${response.status}`);
      return { body: response.body, size: Number(response.headers.get("content-length") || 0), httpMetadata: { contentType: response.headers.get("content-type") || undefined } };
    },
    async delete(key) {
      const response = await request("DELETE", key);
      if (!response.ok && response.status !== 404) throw new Error(`s3_delete_failed:${response.status}`);
    },
  };
}
