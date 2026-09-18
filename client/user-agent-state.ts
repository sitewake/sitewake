export type SiteWakeStateDetail = {
  state: "booting" | "ready" | "error";
  siteAgentId: string;
  releaseVersion?: number;
  message?: string;
};

export function dispatchSiteWakeState(target: EventTarget, detail: SiteWakeStateDetail) {
  target.dispatchEvent(new CustomEvent<SiteWakeStateDetail>("sitewake:state", { detail }));
}
