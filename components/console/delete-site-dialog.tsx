"use client";

import { useState } from "react";
import { ConfirmDialog } from "../ui";
import { t } from "../../lib/i18n";
import { siteAgentClientErrorMessage } from "../../lib/site-knowledge/errors";

/**
 * Confirmation dialog for deleting a site. Shared by "site settings → data" and the
 * "system settings → sites" list: same explanation, same gate (type the site name),
 * same request.
 *
 * It demands a name beyond ConfirmDialog's default because this loses everything a
 * site accumulated — not in the same league as "cancel a crawl". Both sides of the
 * name comparison are trimmed + NFKC, case-sensitive — a name is a name.
 */
export function normalizeSiteName(value: string) {
  return value.trim().normalize("NFKC");
}

export async function requestSiteDeletion(siteAgentId: string) {
  const response = await fetch(`/api/site-agents/${encodeURIComponent(siteAgentId)}`, { method: "DELETE" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw Object.assign(new Error(siteAgentClientErrorMessage(response.status, body)), { status: response.status, code: (body as { error?: string }).error });
  }
  return body as { deleted: true; persistence: string };
}

type DeleteSiteDialogProps = {
  /** Empty means closed. */
  site?: { id: string; name: string };
  onDeleted: (siteAgentId: string) => void;
  onCancel: () => void;
};

/** Keyed by site id: switching site or reopening carries over no typed name, error or pending state. */
export function DeleteSiteDialog(props: DeleteSiteDialogProps) {
  return <DeleteSiteDialogBody key={props.site?.id ?? ""} {...props} />;
}

function DeleteSiteDialogBody({ site, onDeleted, onCancel }: DeleteSiteDialogProps) {
  const copy = t().confirm.deleteSite;
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const open = Boolean(site);
  const matches = Boolean(site) && normalizeSiteName(typed) === normalizeSiteName(site!.name) && normalizeSiteName(typed).length > 0;

  async function confirm() {
    if (!site || !matches || busy) return;
    setBusy(true); setError("");
    try {
      await requestSiteDeletion(site.id);
      onDeleted(site.id);
    } catch (reason) {
      // Stay open on failure: the site still exists; the user can retry or cancel.
      setError(reason instanceof Error && reason.message ? reason.message : copy.failed);
    } finally {
      setBusy(false);
    }
  }

  const name = site?.name || "";
  return (
    <ConfirmDialog
      open={open}
      title={copy.title}
      confirmLabel={copy.confirmLabel}
      busy={busy}
      confirmDisabled={!matches}
      width={420}
      onConfirm={() => void confirm()}
      onCancel={() => { if (!busy) onCancel(); }}
      body={
        <div className="sw-delete-site">
          {/* 一句话说完：谁、丢什么、回不来。类别不逐条罗列，「全部」已经说清楚了。 */}
          <p className="sw-delete-site-lead"><strong>{name}</strong> {copy.consequence}{copy.reversibility}</p>
          <label className="sw-delete-site-confirm">
            <span>{copy.confirmPrefix} <code>{name}</code> {copy.confirmSuffix}</span>
            <input
              type="text"
              aria-label={copy.inputLabel}
              placeholder={name}
              value={typed}
              disabled={busy}
              data-autofocus
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setTyped(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter" && matches && !busy) void confirm(); }}
            />
          </label>
          {error
            ? <p className="sw-delete-site-error" role="alert">{error}</p>
            : <p className="sw-delete-site-note">{copy.scriptReminder}</p>}
        </div>
      }
    />
  );
}
