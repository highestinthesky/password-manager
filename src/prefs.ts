/**
 * prefs.ts — non-secret user preferences (auto-lock + clipboard timing).
 * Stored in localStorage (works in both the web build and the Tauri webview,
 * same as the sync email). Nothing here is sensitive, so it lives outside the
 * encrypted vault.
 */

export interface Prefs {
  autoLockMs: number;
  clipboardClearMs: number;
}

export const AUTO_LOCK_OPTIONS = [60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000];
export const CLIPBOARD_OPTIONS = [15_000, 30_000, 60_000];

const DEFAULTS: Prefs = { autoLockMs: 5 * 60_000, clipboardClearMs: 30_000 };
const KEY = "pm.prefs.v1";

export function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const p = JSON.parse(raw) as Partial<Prefs>;
    return {
      autoLockMs:
        typeof p.autoLockMs === "number" && p.autoLockMs > 0
          ? p.autoLockMs
          : DEFAULTS.autoLockMs,
      clipboardClearMs:
        typeof p.clipboardClearMs === "number" && p.clipboardClearMs > 0
          ? p.clipboardClearMs
          : DEFAULTS.clipboardClearMs,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function savePrefs(p: Prefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* storage may be unavailable — preferences just won't persist */
  }
}
