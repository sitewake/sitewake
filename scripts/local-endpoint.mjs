/** The control plane origin a local `npm run dev` listens on, as the browser reaches it. */
export function controlPlaneUrl(env = process.env) {
  const configured = String(env.SITEWAKE_LOCAL_URL || "").trim();
  if (configured) return configured.replace(/\/$/, "");
  const port = String(env.PORT || "3000");
  return `http://localhost:${port}`;
}
