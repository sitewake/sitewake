const SENSITIVE_NAME = /(?:^|[_-])(?:access[_-]?token|refresh[_-]?token|token|session|sid|jwt|authorization|auth|password|passwd|secret|api[_-]?key|private[_-]?key|credential|credentials|cookie|ticket|assertion|signature|sig|x[_-]?amz[_-]?signature)(?:$|[_-])/i;
const SENSITIVE_URL_PARAMETER = /(?:^|[_-])(?:code|ticket|assertion|signature|sig|x[_-]?amz[_-]?signature)(?:$|[_-])/i;

function sanitizeUrl(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return value;
    url.username = "";
    url.password = "";
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_NAME.test(key) || SENSITIVE_URL_PARAMETER.test(key)) {
        url.searchParams.set(key, "[redacted]");
      }
    }
    if (url.hash && !url.hash.includes("=")) {
      let malformedFragment = false;
      let fragment = url.hash.slice(1);
      try {
        fragment = decodeURIComponent(fragment);
      } catch {
        malformedFragment = true;
      }
      const hashRoute = fragment.startsWith("/") || fragment.startsWith("!/");
      const looksOpaque = fragment.length >= 24
        && /[A-Za-z]/.test(fragment)
        && /\d/.test(fragment);
      if (malformedFragment
        || (!hashRoute && (SENSITIVE_NAME.test(fragment) || looksOpaque))) {
        url.hash = "[redacted]";
      }
    } else if (url.hash.includes("=")) {
      const params = new URLSearchParams(url.hash.replace(/^#/, ""));
      let changed = false;
      for (const key of [...params.keys()]) {
        if (!SENSITIVE_NAME.test(key) && !SENSITIVE_URL_PARAMETER.test(key)) continue;
        params.set(key, "[redacted]");
        changed = true;
      }
      if (changed) url.hash = params.toString();
    }
    return url.toString();
  } catch {
    return value;
  }
}

function sanitizeText(value: string) {
  return value
    .replace(/\bhttps?:\/\/[^\s<>"')\]]+/gi, (url) => sanitizeUrl(url))
    .replace(
      /(^|[\s?&#,;])((?:access[_-]?token|refresh[_-]?token|token|session|sid|jwt|authorization|auth|password|passwd|secret|api[_-]?key|private[_-]?key|credential|credentials|cookie|code|ticket|assertion|signature|sig|x[_-]?amz[_-]?signature)\s*[=:]\s*)[^&\s,;]+/gim,
      "$1$2[redacted]",
    );
}

function redactScalar(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactScalar);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, redactScalar(child)]),
    );
  }
  if (value === null || value === undefined) return value;
  return "[redacted]";
}

function sanitizeValue(
  value: unknown,
  key = "",
  sensitiveContainer = false,
): unknown {
  if (Array.isArray(value)) {
    return value.map((child) => sanitizeValue(child, key, sensitiveContainer));
  }
  if (value && typeof value === "object") {
    const nextSensitive = sensitiveContainer || SENSITIVE_NAME.test(key);
    const schemaLike = !Array.isArray(value)
      && ("type" in value
        || "properties" in value
        || "items" in value
        || "description" in value
        || "required" in value);
    if (nextSensitive && !schemaLike) return redactScalar(value);
    return Object.fromEntries(
      Object.entries(value).map(([childKey, child]) => {
        if (nextSensitive
          && /^(?:examples?|enum|default|const|value|evidence|observedValue)$/i.test(childKey)) {
          return [childKey, redactScalar(child)];
        }
        const structuralSchemaField = schemaLike
          && /^(?:type|description|title|required|properties|items|additionalProperties|oneOf|anyOf|allOf|minimum|maximum|minLength|maxLength|minItems|maxItems|pattern|format)$/i.test(childKey);
        return [childKey, sanitizeValue(
          child,
          childKey,
          structuralSchemaField ? false : nextSensitive,
        )];
      }),
    );
  }
  if (typeof value === "string") {
    if (sensitiveContainer || SENSITIVE_NAME.test(key)) return "[redacted]";
    return sanitizeText(value);
  }
  return sensitiveContainer ? "[redacted]" : value;
}

/** Redacts credential values from the public SDK manifest and Knowledge view. */
export function sanitizePublicRuntime<T>(value: T): T {
  return sanitizeValue(value) as T;
}
