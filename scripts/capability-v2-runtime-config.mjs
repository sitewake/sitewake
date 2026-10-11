const INHERITED_RUNNER_ENV_KEYS = [
  "SystemRoot", "ComSpec", "PATH", "PATHEXT", "TEMP", "TMP", "NODE_OPTIONS", "NODE_ENV",
  "PLAYWRIGHT_BROWSERS_PATH",
  "MODEL_API_KEY", "MODEL_BASE_URL", "MODEL", "MODEL_EXECUTION", "MODEL_SEMANTIC",
  "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL",
  // The control plane's internal model proxy and the token it accepts: how a
  // runner reaches the model without ever holding the provider key.
  "SITEWAKE_MODEL_PROXY_URL", "CAPABILITY_V2_DISPATCH_TOKEN",
  "CAPABILITY_V2_ARTIFACT_DIR", "CAPABILITY_V2_INTERACTION_TIMEOUT_MS",
];

function configured(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function capabilityV2BrowserPublicUrl(sourceEnvironment, fallbackUrl) {
  return configured(sourceEnvironment.CAPABILITY_V2_BROWSER_PUBLIC_URL)
    || configured(sourceEnvironment.SITEWAKE_PUBLIC_ORIGIN)
    || (sourceEnvironment.SITEWAKE_LOCAL_DEV === "1" && sourceEnvironment.NODE_ENV !== "production"
      ? configured(fallbackUrl)
      : "");
}

export function buildCapabilityV2RunnerEnvironment(input, sourceEnvironment = process.env) {
  const validation = input.taskType === "Validation";
  const modelKeys = new Set([
    "MODEL_API_KEY", "MODEL_BASE_URL", "MODEL", "MODEL_EXECUTION", "MODEL_SEMANTIC",
    "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL",
  ]);
  const inherited = Object.fromEntries(INHERITED_RUNNER_ENV_KEYS.filter((key) => !validation || !modelKeys.has(key)).flatMap((key) => (
    sourceEnvironment[key] === undefined ? [] : [[key, sourceEnvironment[key]]]
  )));
  const controlPlaneUrl = configured(input.controlPlaneUrl)
    || configured(sourceEnvironment.CAPABILITY_V2_CONTROL_PLANE_URL)
    || "http://127.0.0.1:3000";
  const browserPublicUrl = configured(input.browserPublicUrl)
    || capabilityV2BrowserPublicUrl(sourceEnvironment, controlPlaneUrl);

  return {
    ...inherited,
    CAPABILITY_V2_SITE_ID: input.siteId,
    CAPABILITY_V2_TASK_ID: input.taskId,
    CAPABILITY_V2_RUNNER_ID: input.runnerId,
    CAPABILITY_V2_SKIP_REGISTER: "1",
    CAPABILITY_V2_RUNNER_TOKEN: input.runnerToken,
    CAPABILITY_V2_TASK_TYPE: input.taskType || "Discovery",
    CAPABILITY_V2_CONTROL_PLANE_URL: controlPlaneUrl,
    ...(browserPublicUrl ? { CAPABILITY_V2_BROWSER_PUBLIC_URL: browserPublicUrl } : {}),
    ...(input.allowPrivateOrigin ? { CAPABILITY_V2_ALLOW_PRIVATE_ORIGIN: "1" } : {}),
    ...(input.interactionTimeoutMs ? { CAPABILITY_V2_INTERACTION_TIMEOUT_MS: String(input.interactionTimeoutMs) } : {}),
  };
}

export function assertCapabilityV2ValidationEnvironment(environment = process.env) {
  const forbidden = [
    "MODEL_API_KEY", "MODEL_BASE_URL", "MODEL", "MODEL_EXECUTION", "MODEL_SEMANTIC",
    "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL",

  ];
  const present = forbidden.filter((key) => configured(environment[key]));
  if (present.length) throw new Error(`validation_runner_model_credentials_present:${present.join(",")}`);
  return true;
}
