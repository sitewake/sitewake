"use client";

import { useEffect, useRef, type ReactNode } from "react";

/**
 * Focus management for dialogs.
 *
 * Traps Tab within `container`, closes on Escape, and restores focus to
 * whatever was focused before the dialog opened. Extracted so every dialog
 * gets this once rather than each one re-implementing (and forgetting) it.
 */
export function useFocusTrap(
  container: React.RefObject<HTMLElement | null>,
  { active, onClose }: { active: boolean; onClose?: () => void },
) {
  // Read the latest `onClose` through a ref so the effect below keys only on
  // `active`. Consumers routinely pass an inline arrow, which is a new identity
  // on every render; re-running the effect on each keystroke handed focus back
  // to the opener and made a dialog with a text field unusable.
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!active) return;
    const root = container.current;
    if (!root) return;
    // Bind to a local so the nested handlers keep the non-null narrowing.
    const dialog = root;
    const previouslyFocused = document.activeElement as HTMLElement | null;

    const focusable = () => Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
      ),
    ).filter((element) => element.offsetParent !== null || element === document.activeElement);

    // Move focus inside on open, preferring an explicit autofocus target. A
    // disabled one (a confirm gated on typed input) cannot take focus; fall
    // through to the first focusable control instead of leaving focus outside.
    const preferred = dialog.querySelector<HTMLElement>('[data-autofocus]:not([data-autofocus="false"]):not([disabled])');
    const initial = preferred || focusable()[0] || dialog;
    initial.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && close.current) {
        event.stopPropagation();
        close.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (!items.length) {
        event.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const current = document.activeElement;
      // Wrap in both directions so focus cannot escape to the page behind.
      if (!event.shiftKey && current === last) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && current === first) {
        event.preventDefault();
        last.focus();
      } else if (current instanceof Node && !dialog.contains(current)) {
        event.preventDefault();
        first.focus();
      }
    }

    dialog.ownerDocument.addEventListener("keydown", onKeyDown, true);
    return () => {
      dialog.ownerDocument.removeEventListener("keydown", onKeyDown, true);
      // Restore focus to the opener. By cleanup time the dialog is usually
      // already detached, which leaves focus on <body>, so treat "focus is on
      // body, inside the dialog, or gone" as ours to reclaim — but leave it
      // alone if the user has since focused something else on the page.
      if (!previouslyFocused?.isConnected) return;
      const active = document.activeElement;
      const focusIsLoose = !active
        || active === document.body
        || dialog.contains(active)
        || !active.isConnected;
      if (focusIsLoose) previouslyFocused.focus();
    };
  }, [active, container]);
}

/** Runs `onClose` when the pointer goes down outside `container`. */
export function useDismissOnOutside(
  container: React.RefObject<HTMLElement | null>,
  { active, onClose }: { active: boolean; onClose: () => void },
) {
  const handler = useRef(onClose);
  // Assigning a ref during render is not allowed; sync it in an effect so the
  // listener below always calls the latest callback without re-subscribing.
  useEffect(() => {
    handler.current = onClose;
  }, [onClose]);
  useEffect(() => {
    if (!active) return;
    function onPointerDown(event: PointerEvent) {
      const root = container.current;
      if (root && event.target instanceof Node && !root.contains(event.target)) handler.current();
    }
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [active, container]);
}

/**
 * Activates a non-button element on Enter/Space, matching native button
 * semantics. Rows rendered as `<i role="button">` were previously mouse-only.
 */
export function activateOnKey(onActivate: () => void) {
  return (event: React.KeyboardEvent) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onActivate();
  };
}

/** Roving arrow-key navigation for a tablist or menu. */
export function useArrowNavigation(
  container: React.RefObject<HTMLElement | null>,
  { orientation = "horizontal", active = true }: { orientation?: "horizontal" | "vertical"; active?: boolean } = {},
) {
  useEffect(() => {
    const root = container.current;
    if (!active || !root) return;
    const list = root;
    const nextKey = orientation === "horizontal" ? "ArrowRight" : "ArrowDown";
    const prevKey = orientation === "horizontal" ? "ArrowLeft" : "ArrowUp";
    function onKeyDown(event: KeyboardEvent) {
      if (![nextKey, prevKey, "Home", "End"].includes(event.key)) return;
      const items = Array.from(list.querySelectorAll<HTMLElement>('[role="tab"],[role="menuitem"]'))
        .filter((element) => !element.hasAttribute("disabled"));
      if (items.length < 2) return;
      const index = items.indexOf(document.activeElement as HTMLElement);
      if (index < 0) return;
      event.preventDefault();
      const target = event.key === "Home" ? 0
        : event.key === "End" ? items.length - 1
        : event.key === nextKey ? (index + 1) % items.length
        : (index - 1 + items.length) % items.length;
      items[target].focus();
    }
    list.addEventListener("keydown", onKeyDown);
    return () => list.removeEventListener("keydown", onKeyDown);
  }, [container, orientation, active]);
}

/** Shared shape for the slot-style states every data view needs. */
export type ViewStateSlots = {
  loading?: boolean;
  error?: string;
  empty?: ReactNode;
};
