/**
 * Console UI primitives.
 *
 * Accessibility lives here rather than in each view: focus trapping, keyboard
 * activation, aria wiring and announced status are solved once and inherited.
 * Styles reuse the shared `.sa-*` classes in app/globals.css.
 */
export { Button } from "./button";
export { Modal, ConfirmDialog } from "./modal";
export { Badge, OutcomeBadge, outcomeLabel, outcomeHint } from "./badge";
export { Spinner, EmptyState, ErrorState, ToastStack, useToasts } from "./feedback";
export type { ToastMessage, ToastTone } from "./feedback";
export { TruncatedId, Timestamp, formatCount, relativeTime } from "./data";
export { DataTable } from "./data-table";
export type { Column } from "./data-table";
export { Card, StatCard, StatGrid, Tabs, Field } from "./layout";
export type { TabItem } from "./layout";
export { useFocusTrap, useDismissOnOutside, useArrowNavigation, activateOnKey } from "./behavior";
