/**
 * Is the chat thread this notification is about the one on screen?
 *
 * Decided from the route's own `?session=` param rather than the store's
 * active session, which stays set after the user navigates away and would
 * suppress the toast app-wide.
 */
export function isViewingSession(
  route: { readonly name?: unknown; readonly query: Record<string, unknown> },
  sessionId: string | undefined
): boolean {
  if (sessionId === undefined) return false
  return route.name === "chat" && route.query["session"] === sessionId
}
