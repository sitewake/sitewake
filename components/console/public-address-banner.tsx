"use client";

import { useCallback, useEffect, useState } from "react";
import type { Locale } from "../../lib/i18n";
import { publicAddressCopy } from "../../lib/console/public-address-copy";
import { localHostname } from "../../lib/console/public-address-check";
import type { PublicAddressView } from "./public-address-settings";

/**
 * Whether this installation can serve a website on the internet is one fact
 * about the installation, not about each website — so it is read once here and
 * said once, in the shell, instead of being repeated next to every site.
 */

export function usePublicAddress() {
  const [address, setAddress] = useState<PublicAddressView>();
  const reload = useCallback(async () => {
    try {
      const response = await fetch("/api/system/public-address", { cache: "no-store" });
      if (!response.ok) return;
      const body = (await response.json()) as Partial<PublicAddressView>;
      // Only a real answer counts: anything else leaves the console behaving
      // as it did before this setting existed, rather than announcing a
      // problem it has no evidence for.
      if (typeof body.usableForPublicSites === "boolean") setAddress(body as PublicAddressView);
    } catch {
      // Unreadable right now: the console behaves as it did before this
      // setting existed rather than blocking on it.
    }
  }, []);
  useEffect(() => { void reload(); }, [reload]);
  return { address, reload };
}

/** The address the install snippet must carry, or "" while nothing is known. */
export function snippetOrigin(address: PublicAddressView | undefined, fallback: string) {
  return address?.origin || fallback;
}

/** Is this website one that only a visitor on the internet would open? */
export function publicWebsite(url: string | undefined) {
  if (!url) return false;
  try { return !localHostname(new URL(url).hostname); } catch { return false; }
}

export function PublicAddressBanner({ locale, address, sites, onOpenSettings }: {
  locale: Locale;
  address: PublicAddressView | undefined;
  /** Entry addresses of the websites in this installation. */
  sites: string[];
  onOpenSettings(): void;
}) {
  const copy = publicAddressCopy(locale);
  // Nothing to say while local websites are the only ones here: that pairing
  // works, and a warning would be noise.
  if (!address || address.usableForPublicSites) return null;
  if (!sites.some(publicWebsite)) return null;
  return (
    <div className="sw-public-address-banner" role="status" data-public-address-banner>
      <div>
        <strong>{copy.bannerTitle}</strong>
        <p>{copy.bannerBody(address.origin)}</p>
      </div>
      <button type="button" className="sw-secondary-button" onClick={onOpenSettings}>{copy.bannerAction}</button>
    </div>
  );
}
