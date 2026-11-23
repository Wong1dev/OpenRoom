/**
 * Chat session guard — keeps one session's chat out of another session's file.
 *
 * ChatPanel holds the chat of exactly one session (character × mod) in memory.
 * When the active session changes (e.g. the server's character list arrives
 * after the page started with the cached one), two things can go wrong:
 *
 *  1. A history load started for the previous session resolves late and its
 *     messages are shown (and then saved) under the new session.
 *  2. A debounced save scheduled for the previous session's messages fires
 *     after the switch and writes them to the new session's file.
 *
 * The guard records which session the in-memory chat belongs to ("owner"):
 *  - `switchTo(path)` when the active session changes: until that session's
 *    history has loaded, the in-memory chat belongs to nobody.
 *  - `isCurrent(path)` before applying a load result: drop stale loads.
 *  - `loaded(path)` when a load result (or a seeded prologue) is applied.
 *  - `saveTarget()` returns where a save may go, or null to skip it.
 */
export interface ChatSessionGuard {
  /** The active session changed (no-op if it is the one already owned). */
  switchTo(path: string): void;
  /** True if `path` is still the active session (i.e. a load for it is not stale). */
  isCurrent(path: string): boolean;
  /** The chat for `path` has been loaded or seeded; it now owns the in-memory chat. */
  loaded(path: string): void;
  /** Session the in-memory chat may be saved to, or null while it belongs to none. */
  saveTarget(): string | null;
}

export function createChatSessionGuard(initialPath: string): ChatSessionGuard {
  let active = initialPath;
  let owner: string | null = null;
  return {
    switchTo(path) {
      active = path;
      if (owner !== path) owner = null;
    },
    isCurrent(path) {
      return path === active;
    },
    loaded(path) {
      if (path === active) owner = path;
    },
    saveTarget() {
      return owner !== null && owner === active ? owner : null;
    },
  };
}
