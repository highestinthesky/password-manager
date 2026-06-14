/**
 * main.ts — app state machine. Two states: LOCKED (no key, no plaintext)
 * and UNLOCKED (key + entries in memory only). Every mutation re-encrypts
 * and writes the whole vault with a fresh nonce, then pushes to sync (if on).
 */

import {
  deriveKey,
  encryptVault,
  decryptVault,
  keyForVault,
  newSalt,
  newEntryId,
  fromBase64,
  mergeEntries,
  entriesEqual,
  KDF_ITERATIONS,
  type Entry,
  type VaultFile,
} from "./vault";
import { loadVault, saveVault } from "./storage";
import { parseImport } from "./import";
import { toMarkdown, exportFilename } from "./markdown";
import { loadPrefs, savePrefs, type Prefs } from "./prefs";
import * as sync from "./sync";
import { render, type Screen, type Actions } from "./ui";

const APP_VERSION = "0.3.0";
const HIDDEN_GRACE_MS = 30_000; // lock 30s after tab hidden
const PUSH_DEBOUNCE_MS = 1_500;
const SYNC_PULL_MS = 60_000; // background pull while unlocked

// auto-lock + clipboard-clear are now user preferences (prefs.ts)
let prefs: Prefs = loadPrefs();

const root = document.getElementById("app")!;

// --- unlocked-state memory (dropped on lock) ----------------------------------
let key: CryptoKey | null = null;
let salt: Uint8Array | null = null;
let masterPw: string | null = null; // kept while unlocked so pulled vaults (different salt) can be re-derived
let entries: Entry[] = [];

// --- persisted vault file (ciphertext — safe to keep around) -------------------
let cachedVault: VaultFile | null = null;

// --- ui state -------------------------------------------------------------------
let lockBusy = false;
let lockError: string | null = null;
let query = "";
let selected = 0;
let revealedId: string | null = null;
let editing: Entry | "new" | null = null;
let toast: string | null = null;
let toastTimer: number | undefined;
let settingsOpen = false;
let importOpen = false;

/** Visible entries — tombstones (deleted, kept only for sync) are hidden. */
function live(): Entry[] {
  return entries.filter((e) => !e.deleted);
}

function filtered(): Entry[] {
  const items = live();
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter(
    (e) =>
      e.title.toLowerCase().includes(q) ||
      e.username.toLowerCase().includes(q) ||
      e.keywords.some((k) => k.toLowerCase().includes(q)),
  );
}

function screen(): Screen {
  if (!key)
    return {
      kind: "locked",
      mode: cachedVault ? "unlock" : "create",
      busy: lockBusy,
      error: lockError,
      syncAvailable: sync.syncEnabled(),
      toast,
    };
  const list = filtered();
  selected = Math.min(selected, Math.max(0, list.length - 1));
  return {
    kind: "list",
    entries: list,
    query,
    selected,
    revealedId,
    editing,
    toast,
    syncAvailable: sync.syncEnabled(),
    syncEmail: sync.getSyncEmail(),
    settings: settingsOpen,
    importing: importOpen,
    autoLockMs: prefs.autoLockMs,
    clipboardClearMs: prefs.clipboardClearMs,
    entryCount: live().length,
    appVersion: APP_VERSION,
  };
}

function paint(): void {
  render(root, screen(), actions);
}

// --- persistence -------------------------------------------------------------------
/** Encrypt + write the vault locally (no sync push). */
async function persistLocal(): Promise<void> {
  if (!key || !salt) return;
  cachedVault = await encryptVault(entries, key, salt);
  await saveVault(cachedVault);
}

/** Local save + schedule a debounced sync push. */
async function persist(): Promise<void> {
  await persistLocal();
  schedulePush();
}

// --- lock / unlock --------------------------------------------------------------------
function lock(): void {
  key = null;
  salt = null;
  masterPw = null;
  entries = [];
  query = "";
  selected = 0;
  revealedId = null;
  editing = null;
  toast = null;
  lockError = null;
  settingsOpen = false;
  importOpen = false;
  stopIdleTimer();
  stopSyncTimer();
  paint();
}

async function unlock(password: string): Promise<void> {
  if (!password || lockBusy) return;
  lockBusy = true;
  lockError = null;
  paint();
  await new Promise((r) => setTimeout(r, 30)); // let "deriving key…" paint before KDF blocks
  try {
    if (!cachedVault) throw new Error("No vault found");
    const k = await keyForVault(cachedVault, password);
    entries = await decryptVault(cachedVault, k); // throws on wrong password (GCM auth)
    key = k;
    salt = fromBase64(cachedVault.kdf.salt);
    masterPw = password;
    startIdleTimer();
    startSyncTimer();
    if (sync.syncEnabled()) void runSync(false);
  } catch {
    lockError = "Wrong password";
  } finally {
    lockBusy = false;
    paint();
  }
}

async function createVault(password: string, confirm: string): Promise<void> {
  if (lockBusy) return;
  if (password.length < 8) {
    lockError = "Use at least 8 characters";
    paint();
    return;
  }
  if (password !== confirm) {
    lockError = "Passwords don't match";
    paint();
    return;
  }
  lockBusy = true;
  lockError = null;
  paint();
  await new Promise((r) => setTimeout(r, 30));
  const s = newSalt();
  const k = await deriveKey(password, s, KDF_ITERATIONS);
  key = k;
  salt = s;
  masterPw = password;
  entries = [];
  await persist();
  lockBusy = false;
  startIdleTimer();
  startSyncTimer();
  if (sync.syncEnabled()) void runSync(false);
  paint();
}

// --- sync ----------------------------------------------------------------------------
let pushTimer: number | undefined;

function schedulePush(): void {
  if (!sync.syncEnabled()) return;
  clearTimeout(pushTimer);
  // route through runSync so stale-session recovery applies to pushes too
  pushTimer = window.setTimeout(() => void runSync(false), PUSH_DEBOUNCE_MS);
}

let syncTimer: number | undefined;

/**
 * First-run on a new device: type the master password, click restore.
 * Derives the sync credential, pulls the vault, decrypts, and unlocks —
 * all from the one password.
 */
async function restoreFromSync(password: string): Promise<void> {
  if (lockBusy) return;
  if (!password) {
    lockError = "Type your master password first, then click restore";
    paint();
    return;
  }
  lockBusy = true;
  lockError = null;
  paint();
  await new Promise((r) => setTimeout(r, 30));
  try {
    await sync.ensureSignedIn(password);
    const remote = await sync.pullVault();
    if (!remote) {
      lockError = "Nothing in sync yet — create a vault on your main device first";
      return;
    }
    const k = await keyForVault(remote, password);
    entries = await decryptVault(remote, k); // throws if master password differs
    key = k;
    salt = fromBase64(remote.kdf.salt);
    masterPw = password;
    cachedVault = remote;
    await saveVault(remote);
    startIdleTimer();
    startSyncTimer();
    void runSync(false); // reconcile + start realtime
    showToast("✓ vault restored from sync");
  } catch (e) {
    lockError = e instanceof Error ? e.message : "restore failed";
  } finally {
    lockBusy = false;
    paint();
  }
}

/** Background auto-sync: every 60s while unlocked + on window focus + on realtime push. */
function startSyncTimer(): void {
  if (!sync.syncEnabled()) return;
  clearInterval(syncTimer);
  syncTimer = window.setInterval(() => void autoSync(), SYNC_PULL_MS);
}
function stopSyncTimer(): void {
  clearInterval(syncTimer);
  stopRealtime();
}
function autoSync(): Promise<void> | void {
  // skip mid-edit so a merge never swaps entries under an open modal
  if (key && !editing && !settingsOpen && sync.syncEnabled()) return runSync(false);
}
window.addEventListener("focus", () => void autoSync());

// Realtime: subscribe once we're signed in; another device's push pings autoSync.
let unsub: (() => void) | null = null;
function ensureRealtime(): void {
  if (unsub || !sync.syncEnabled()) return;
  unsub = sync.subscribeVault(() => void autoSync());
}
function stopRealtime(): void {
  unsub?.();
  unsub = null;
}

let syncing = false;

/**
 * Pull the remote vault, merge entry-by-entry with the local one (newest write
 * wins per entry, deletes propagate via tombstones), then push if the remote is
 * missing anything. Idempotent — a no-op converges without a write, so the
 * realtime echo of our own push can't loop.
 */
async function runSync(interactive = true): Promise<void> {
  if (!sync.syncEnabled() || !key || !masterPw || syncing) return;
  syncing = true;
  try {
    await sync.ensureSignedIn(masterPw);
    ensureRealtime();
    const remote = await sync.pullVault();

    if (!remote) {
      if (!cachedVault) await persistLocal();
      if (cachedVault) await sync.pushVault(cachedVault);
      if (interactive) showToast("✓ pushed to sync");
      return;
    }

    let remoteEntries: Entry[];
    try {
      remoteEntries = await decryptVault(remote, await keyForVault(remote, masterPw));
    } catch {
      if (interactive)
        showToast("⚠ remote vault uses a different master password — kept local copy");
      return;
    }

    const merged = mergeEntries(entries, remoteEntries);
    const localChanged = !entriesEqual(merged, entries);
    const remoteChanged = !entriesEqual(merged, remoteEntries);

    if (localChanged) {
      entries = merged;
      await persistLocal();
      paint();
    }
    if (remoteChanged) {
      if (!cachedVault || localChanged) await persistLocal();
      await sync.pushVault(cachedVault!);
    }
    if (interactive)
      showToast(
        localChanged ? "✓ pulled latest from sync"
        : remoteChanged ? "✓ pushed to sync"
        : "✓ in sync",
      );
  } catch (e) {
    // background failures stay quiet — local-first, it retries on the next tick
    if (interactive)
      showToast(`⚠ sync failed: ${e instanceof Error ? e.message : "offline?"}`);
  } finally {
    syncing = false;
  }
}

// --- auto-lock --------------------------------------------------------------------------
let idleTimer: number | undefined;
let hiddenTimer: number | undefined;

function startIdleTimer(): void {
  clearTimeout(idleTimer);
  idleTimer = window.setTimeout(lock, prefs.autoLockMs);
}
function stopIdleTimer(): void {
  clearTimeout(idleTimer);
  clearTimeout(hiddenTimer);
}
["pointerdown", "keydown", "scroll"].forEach((ev) =>
  window.addEventListener(ev, () => {
    if (key) startIdleTimer();
  }),
);
document.addEventListener("visibilitychange", () => {
  if (!key) return;
  if (document.hidden) {
    hiddenTimer = window.setTimeout(lock, HIDDEN_GRACE_MS);
  } else {
    clearTimeout(hiddenTimer);
  }
});

// --- clipboard ----------------------------------------------------------------------------
let clipTimer: number | undefined;

async function copyToClipboard(text: string, what: string): Promise<void> {
  await navigator.clipboard.writeText(text);
  showToast(`✓ ${what} copied — clears in 30s`);
  clearTimeout(clipTimer);
  clipTimer = window.setTimeout(async () => {
    try {
      // only clear if the clipboard still contains what we copied
      if ((await navigator.clipboard.readText()) === text)
        await navigator.clipboard.writeText("");
    } catch {
      /* clipboard read may be denied when unfocused — skip clearing */
    }
  }, prefs.clipboardClearMs);
}

function showToast(msg: string): void {
  toast = msg;
  paint();
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toast = null;
    paint();
  }, 2500);
}

// --- password generator ----------------------------------------------------------------------
function generatePassword(len = 20): string {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*-_=+?";
  const bytes = crypto.getRandomValues(new Uint32Array(len));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

// --- import -------------------------------------------------------------------------------------
/**
 * Merge pasted credentials into the vault. Skips rows that duplicate an
 * existing title+username (case-insensitive) so re-pasting is safe.
 */
function importEntries(text: string): void {
  if (!key) return;
  const { entries: parsed } = parseImport(text);
  if (parsed.length === 0) {
    importOpen = false;
    showToast("Nothing to import");
    return;
  }
  const sig = (title: string, user: string) =>
    `${title.toLowerCase()} ${user.toLowerCase()}`;
  const seen = new Set(live().map((e) => sig(e.title, e.username)));
  let added = 0;
  let skipped = 0;
  for (const p of parsed) {
    const s = sig(p.title, p.username);
    if (seen.has(s)) {
      skipped++;
      continue;
    }
    seen.add(s);
    const entry: Entry = {
      id: newEntryId(),
      title: p.title,
      username: p.username,
      password: p.password,
      keywords: p.keywords,
      updatedAt: Date.now(),
    };
    if (p.notes) entry.notes = p.notes;
    entries.push(entry);
    added++;
  }
  importOpen = false;
  if (added > 0) void persist();
  showToast(
    `✓ imported ${added}` +
      (skipped ? `, skipped ${skipped} duplicate${skipped === 1 ? "" : "s"}` : ""),
  );
}

// --- export -------------------------------------------------------------------------------------
const isTauriEnv =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Export the decrypted vault as a Markdown file. Plaintext — confirmed in the UI. */
async function exportVault(): Promise<void> {
  if (!key) return;
  const md = toMarkdown(live());
  const name = exportFilename();
  try {
    if (isTauriEnv) {
      const { writeTextFile, mkdir, BaseDirectory } = await import("@tauri-apps/plugin-fs");
      try {
        await writeTextFile(name, md, { baseDir: BaseDirectory.Download });
        showToast(`✓ exported to Downloads/${name}`);
      } catch {
        // Download scope not granted — fall back to the app data dir
        try {
          await mkdir("", { baseDir: BaseDirectory.AppData, recursive: true });
        } catch {
          /* already exists */
        }
        await writeTextFile(name, md, { baseDir: BaseDirectory.AppData });
        showToast(`✓ exported ${name} (app data folder)`);
      }
    } else {
      const blob = new Blob([md], { type: "text/markdown" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1_000);
      showToast(`✓ exported ${name}`);
    }
  } catch (e) {
    showToast(`⚠ export failed: ${e instanceof Error ? e.message : "unknown"}`);
  }
  settingsOpen = false;
  paint();
}

// --- actions ------------------------------------------------------------------------------------
const actions: Actions = {
  unlock: (pw) => void unlock(pw),
  create: (pw, confirm) => void createVault(pw, confirm),
  lock,
  setQuery(q) {
    query = q;
    selected = 0;
    paint();
  },
  select(i) {
    selected = i;
    paint();
  },
  copyPassword: (e) => void copyToClipboard(e.password, "password"),
  copyUsername: (e) => void copyToClipboard(e.username, "username"),
  revealStart(e) {
    revealedId = e.id;
    paint();
  },
  revealEnd() {
    if (!revealedId) return;
    revealedId = null;
    paint();
  },
  openEdit(e) {
    editing = e;
    paint();
  },
  closeEdit() {
    editing = null;
    paint();
  },
  saveEntry(e) {
    const stamped: Entry = { ...e, updatedAt: Date.now(), deleted: false };
    const i = entries.findIndex((x) => x.id === stamped.id);
    if (i >= 0) entries[i] = stamped;
    else entries.push(stamped);
    editing = null;
    void persist();
    paint();
  },
  deleteEntry(id) {
    // tombstone, not removal — strip the secret but keep the id so the delete
    // propagates through sync and isn't resurrected by another device's copy
    const i = entries.findIndex((x) => x.id === id);
    if (i >= 0) {
      entries[i] = {
        id, title: "", username: "", password: "", keywords: [],
        updatedAt: Date.now(), deleted: true,
      };
    }
    editing = null;
    void persist();
    paint();
  },
  generatePassword,
  restore: (masterPassword) => void restoreFromSync(masterPassword),
  runSync: () => void runSync(true),
  openSettings() {
    settingsOpen = true;
    paint();
  },
  closeSettings() {
    settingsOpen = false;
    paint();
  },
  saveSyncEmail(email) {
    sync.setSyncEmail(email); // drops the old session — different account
    settingsOpen = false;
    showToast(`✓ sync account: ${email}`);
    startSyncTimer();
    void runSync(false); // sign in / auto-create under the new email, then reconcile
  },
  openImport() {
    importOpen = true;
    paint();
  },
  closeImport() {
    importOpen = false;
    paint();
  },
  importEntries,
  setAutoLock(ms) {
    prefs = { ...prefs, autoLockMs: ms };
    savePrefs(prefs);
    if (key) startIdleTimer(); // re-arm with the new timeout
  },
  setClipboardClear(ms) {
    prefs = { ...prefs, clipboardClearMs: ms };
    savePrefs(prefs);
  },
  exportMarkdown: () => void exportVault(),
};

// --- global keyboard (list screen) ------------------------------------------------------------------
window.addEventListener("keydown", (ev) => {
  if (!key) return;
  const mod = ev.metaKey || ev.ctrlKey;
  if (mod && ev.key.toLowerCase() === "l") {
    ev.preventDefault();
    lock();
    return;
  }
  if (mod && ev.key.toLowerCase() === "i" && !editing && !settingsOpen && !importOpen) {
    ev.preventDefault();
    actions.openImport();
    return;
  }
  if (editing || settingsOpen || importOpen) return; // modals handle their own keys
  const list = filtered();
  const cur = list[selected];
  if (ev.key === "ArrowDown") {
    ev.preventDefault();
    selected = Math.min(selected + 1, list.length - 1);
    paint();
  } else if (ev.key === "ArrowUp") {
    ev.preventDefault();
    selected = Math.max(selected - 1, 0);
    paint();
  } else if (ev.key === "Enter" && cur) {
    ev.preventDefault();
    if (mod) void copyToClipboard(cur.username, "username");
    else void copyToClipboard(cur.password, "password");
  } else if (mod && ev.key.toLowerCase() === "e" && cur) {
    ev.preventDefault();
    actions.openEdit(cur);
  } else if (mod && ev.key.toLowerCase() === "n") {
    ev.preventDefault();
    actions.openEdit("new");
  }
});

// --- boot ---------------------------------------------------------------------------------------------
void (async () => {
  cachedVault = await loadVault();
  paint();
})();
