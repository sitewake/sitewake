/** Shared by authoring/validation Runner and the website SDK.
 * A URL is a destination, not proof that a new document will be created.
 * Already-reached SPA destinations and hash changes keep the current owner.
 */
export function capabilityNavigationKind(currentUrl: string, destinationUrl: string): "same-document" | "new-document" {
  const current = new URL(currentUrl);
  const destination = new URL(destinationUrl, current);
  return destination.origin === current.origin
    && destination.pathname === current.pathname
    && destination.search === current.search
    ? "same-document" : "new-document";
}
