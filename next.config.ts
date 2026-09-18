import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // SDK integration URLs are intentionally stable: developers paste them once
  // into their website. They must therefore revalidate on every use; otherwise
  // a browser can keep an older Agent protocol alive after a control-plane
  // deployment. The generated console assets stay content-addressed and are
  // unaffected by this rule.
  //
  // These two are the SDK files onboarding actually hands to users (see
  // lib/console/install-guide.ts); tests/install-guide.test.mjs pins both sides together.
  async headers() {
    return [
      {
        source: "/:sdk(sitewake|sitewake-adaptive).js",
        headers: [
          { key: "Cache-Control", value: "no-cache, must-revalidate" },
          { key: "CDN-Cache-Control", value: "no-cache, must-revalidate" },
        ],
      },
    ];
  },
};

export default nextConfig;
