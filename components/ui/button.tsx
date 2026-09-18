"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "default" | "ghost" | "danger";
type Size = "sm" | "md";

type BaseProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className"> & {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  className?: string;
};

/**
 * Icon-only buttons must name themselves. Making this a type-level requirement
 * is the point: the console had unlabelled "⌃" and "×" buttons that screen
 * readers announced as nothing at all.
 */
type ButtonProps =
  | (BaseProps & { children: ReactNode; "aria-label"?: string })
  | (BaseProps & { children?: undefined; "aria-label": string });

export function Button({
  variant = "default",
  size = "md",
  loading = false,
  disabled,
  children,
  className,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      // A button mid-request must not be clickable again, and `aria-busy` is
      // what tells assistive tech the label has not gone stale.
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={["sa-btn", `sa-btn--${variant}`, `sa-btn--${size}`, loading ? "is-loading" : "", className || ""]
        .filter(Boolean)
        .join(" ")}
    >
      {loading && <span className="sa-btn__spinner" aria-hidden="true" />}
      {children}
    </button>
  );
}
