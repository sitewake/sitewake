"use client";

import { t } from "@/lib/i18n";

import { useId, useRef, type ReactNode } from "react";
import { Button } from "./button";
import { useFocusTrap } from "./behavior";

export function Modal({
  open,
  onClose,
  title,
  description,
  footer,
  children,
  width,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  footer?: ReactNode;
  children?: ReactNode;
  width?: number;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  useFocusTrap(dialog, { active: open, onClose });
  if (!open) return null;
  return (
    <div className="sa-modal-backdrop" onMouseDown={onClose}>
      <div
        ref={dialog}
        className="sa-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        style={width ? { width: `min(${width}px, 100%)` } : undefined}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="sa-modal__head">
          <h2 id={titleId}>{title}</h2>
          <Button variant="ghost" size="sm" aria-label={t().common.close} onClick={onClose}>
            ×
          </Button>
        </header>
        {description && (
          <p id={descriptionId} className="sa-modal__description">
            {description}
          </p>
        )}
        {children}
        {footer && <footer className="sa-modal__foot">{footer}</footer>}
      </div>
    </div>
  );
}

/**
 * Replaces `window.confirm` for destructive actions.
 *
 * Unlike the native dialog this can explain consequences and distinguish a
 * reversible action from a permanent one, which the console needs: "unpublish" and
 * "delete" have very different blast radii.
 */
export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel = t().common.confirm,
  cancelLabel = t().common.cancel,
  destructive = true,
  busy = false,
  confirmDisabled = false,
  width = 460,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  body: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  busy?: boolean;
  /** Disables confirm while a precondition is unmet (e.g. the name must be typed first); cancel stays available. */
  confirmDisabled?: boolean;
  width?: number;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal
      open={open}
      onClose={busy ? () => undefined : onCancel}
      title={title}
      width={width}
      footer={
        <>
          <Button onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button
            variant={destructive ? "danger" : "primary"}
            onClick={onConfirm}
            loading={busy}
            disabled={confirmDisabled || busy}
            data-autofocus={confirmDisabled ? undefined : true}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="sa-modal__body">{body}</div>
    </Modal>
  );
}
