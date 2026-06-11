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
  fromBase64,
  KDF_ITERATIONS,
  type Entry,
  type VaultFile,
} from "./vault";
import { loadVault, saveVault } from "./storage";
import * as sync from "./sync";
import { render, type Screen, type Actions } from "./ui";

const AUTO_LOCK_MS = 5 * 60_000; // 5 min idle (hardcoded in v1)
const HIDDEN_GRACE_MS = 30_000; // lock 30s after tab hidden
const CLIPBOARD_CLEAR_MS = 30_000;
const PUSH_DEBOUNCE_MS = 1_500;
const SYNC_PULL_MS = 60_000; // background pull while unlocked

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

function filtered(): Entry[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries;
  return entries.filter(
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
      syncAvailable: sync.syncEnabled,
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
    syncAvailable: sync.syncEnabled,
  };
}

function paint(): void {
  render(root, screen(), actions);
}

// --- persistence -------------------------------------------------------------------
async function persist(): Promise<void> {
  if (!key || !salt) return;
  cachedVault = await encryptVault(entries, key, salt);
  await saveVault(cachedVault);
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
    if (sync.syncEnabled) void runSync(false);
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
  if (sync.syncEnabled) void runSync(false);
  paint();
}

// --- sync ----------------------------------------------------------------------------
let pushTimer: number | undefined;

function schedulePush(): void {
  if (!sync.signedIn()) return;
  clearTimeout(pushTimer);
  pushTimer = window.setTimeout(() => {
    if (cachedVault)
      sync.pushVault(cachedVault).catch(() => showToast("⚠ sync push failed — will retry on next save"));
  }, PUSH_DEBOUNCE_MS);
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
    showToast("✓ vault restored from sync");
  } catch (e) {
    lockError = e instanceof Error ? e.message : "restore failed";
  } finally {
    lockBusy = false;
    paint();
  }
}

/** Background auto-sync: every 60s while unlocked + whenever the window regains focus. */
function startSyncTimer(): void {
  if (!sync.syncEnabled) return;
  clearInterval(syncTimer);
  syncTimer = window.setInterval(() => void autoSync(), SYNC_PULL_MS);
}
function stopSyncTimer(): void {
  clearInterval(syncTimer);
}
function autoSync(): Promise<void> | void {
  // skip mid-edit so a pull never swaps entries under an open modal
  if (key && !editing && sync.syncEnabled) return runSync(false);
}
window.addEventListener("focus", () => void autoSync());

async function runSync(interactive = true): Promise<void> {
  if (!sync.syncEnabled || !key || !masterPw) return;
  try {
    await sync.ensureSignedIn(masterPw); // no-op when already signed in
    const { vault, action } = await sync.syncVault(cachedVault);
    if (action === "pulled" && vault) {
      try {
        // re-derive with the REMOTE vault's salt — each device's vault has its own
        const k2 = await keyForVault(vault, masterPw!);
        entries = await decryptVault(vault, k2);
        key = k2;
        salt = fromBase64(vault.kdf.salt);
        cachedVault = vault;
        await saveVault(vault);
        showToast("✓ pulled latest from sync");
      } catch {
        showToast("⚠ remote vault uses a different master password — kept local copy");
      }
    } else if (action === "pushed" && interactive) {
      showToast("✓ pushed to sync");
    } else if (interactive) {
      showToast("✓ in sync");
    }
  } catch (e) {
    // background failures stay quiet — local-first, it'll retry in 60s
    if (interactive)
      showToast(`⚠ sync failed: ${e instanceof Error ? e.message : "offline?"}`);
  }
}

// --- auto-lock --------------------------------------------------------------------------
let idleTimer: number | undefined;
let hiddenTimer: number | undefined;

function startIdleTimer(): void {
  clearTimeout(idleTimer);
  idleTimer = window.setTimeout(lock, AUTO_LOCK_MS);
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
  }, CLIPBOARD_CLEAR_MS);
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
    const i = entries.findIndex((x) => x.id === e.id);
    if (i >= 0) entries[i] = e;
    else entries.push(e);
    editing = null;
    void persist();
    paint();
  },
  deleteEntry(id) {
    entries = entries.filter((x) => x.id !== id);
    editing = null;
    void persist();
    paint();
  },
  generatePassword,
  restore: (masterPassword) => void restoreFromSync(masterPassword),
  runSync: () => void runSync(true),
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
  if (editing) return; // modal handles its own keys
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
