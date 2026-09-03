import type { PartSummary, PartsConsole, ReservationState } from "./console.ts";

export const WORKSPACE_VIEW_TITLE = "Parts workspace";

export type WorkspaceView = Readonly<{
  title: string;
  parts: readonly PartSummary[];
  reservations: readonly ReservationState[];
}>;

/**
 * Resolves the protected workspace for a session, or `null` when the caller is
 * not authenticated. Callers turn `null` into a 401 interrupt; they never
 * degrade to a partially rendered page.
 */
export function resolveWorkspaceView(app: PartsConsole, session: string, query?: string | null): WorkspaceView | null {
  if (!app.isAuthenticated(session)) return null;
  return {
    title: WORKSPACE_VIEW_TITLE,
    parts: app.listParts(session, query),
    reservations: app.listReservations(session),
  };
}
