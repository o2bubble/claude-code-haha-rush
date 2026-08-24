// ── Session favorites partitioning (pure) ──
// Favorites are workspace-scoped session ids. Partition the live session list
// into: valid favorites (kept in live order), stale favorites (ids no longer in
// the live list — session was deleted) and the regular remainder.

export interface SessionLike {
  id: string;
}

export interface SessionPartition<T extends SessionLike> {
  favSessions: T[];
  staleFavIds: string[];
  regularSessions: T[];
}

export function partitionSessions<T extends SessionLike>(sessions: T[], favIds: string[]): SessionPartition<T> {
  const favSet = new Set(favIds);
  const sessionIdSet = new Set(sessions.map((s) => s.id));
  return {
    favSessions: sessions.filter((s) => favSet.has(s.id)),
    staleFavIds: favIds.filter((id) => !sessionIdSet.has(id)),
    regularSessions: sessions.filter((s) => !favSet.has(s.id)),
  };
}
