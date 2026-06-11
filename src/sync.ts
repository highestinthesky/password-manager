/**
 * sync.ts — Layer 4: Supabase encrypted-blob sync, last-write-wins.
 *
 * Single credential design (Bitwarden-style): the Supabase account password is
 * DERIVED from the master password via PBKDF2 with a different salt domain.
 * The server only ever sees that derived value (then bcrypts it) — it can never
 * recover the master password or the vault key. The email is just an identifier.
 *
 * Sync is a bolt-on: if env vars are missing or the DB is paused, the app
 * works fine from local storage. Setup: supabase/setup.sql + .env.example
 */

import type { VaultFile } from "./vault";

const URL: string | undefined = import.meta.env.VITE_SUPABASE_URL;
const ANON: string | undefined = import.meta.env.VITE_SUPABASE_ANON_KEY;

const EMAIL_KEY = "pm.sync.email";

/** Account identifier. Locally-set value overrides the build-time default. */
export function getSyncEmail(): string | null {
  return (
    localStorage.getItem(EMAIL_KEY) ??
    (import.meta.env.VITE_SYNC_EMAIL as string | undefined) ??
    null
  );
}

/** Changing the email switches accounts, so the old session is dropped. */
export function setSyncEmail(email: string): void {
  localStorage.setItem(EMAIL_KEY, email.trim().toLowerCase());
  signOut();
}

/** True when configured with a Supabase project + sync email. */
export function syncEnabled(): boolean {
  return Boolean(URL && ANON && getSyncEmail());
}

// --- auth password derivation -------------------------------------------------

/**
 * Master password → Supabase account password. Deterministic (same on every
 * device), domain-separated from the vault key (fixed email-based salt vs. the
 * vault's random salt), and one-way (600k PBKDF2).
 */
async function deriveAuthPassword(masterPassword: string): Promise<string> {
  const enc = new TextEncoder();
  const material = await crypto.subtle.importKey(
    "raw",
    enc.encode(masterPassword),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: enc.encode(`pm-sync-auth:${getSyncEmail()!.toLowerCase()}`),
      iterations: 600_000,
    },
    material,
    256,
  );
  let bin = "";
  for (const b of new Uint8Array(bits)) bin += String.fromCharCode(b);
  return btoa(bin);
}

// --- session (stored locally) ----------------------------------------------------

interface Session {
  access_token: string;
  refresh_token: string;
  expires_at: number; // unix seconds
  user_id: string;
}

const SESSION_KEY = "pm.sync.session";

function getSession(): Session | null {
  const raw = localStorage.getItem(SESSION_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Session;
  } catch {
    return null;
  }
}

export function signedIn(): boolean {
  return syncEnabled() && getSession() !== null;
}

export function signOut(): void {
  localStorage.removeItem(SESSION_KEY);
}

interface AuthResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  user: { id: string };
}

async function authPost(path: string, body: unknown): Promise<AuthResponse> {
  const res = await fetch(`${URL}${path}`, {
    method: "POST",
    headers: { apikey: ANON!, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data: unknown = await res.json();
  if (!res.ok) {
    const d = data as { error_description?: string; msg?: string };
    throw new Error(d.error_description ?? d.msg ?? `auth failed (${res.status})`);
  }
  return data as AuthResponse;
}

function storeSession(d: AuthResponse): void {
  const s: Session = {
    access_token: d.access_token,
    refresh_token: d.refresh_token,
    expires_at: Math.floor(Date.now() / 1000) + d.expires_in,
    user_id: d.user.id,
  };
  localStorage.setItem(SESSION_KEY, JSON.stringify(s));
}

/**
 * Sign in using credentials derived from the master password.
 * First ever run auto-creates the account (requires "Confirm email" OFF in
 * Supabase → Authentication, since nobody knows the derived password to type).
 */
export async function ensureSignedIn(masterPassword: string): Promise<void> {
  if (!syncEnabled()) throw new Error("sync not configured");
  if (getSession()) return;
  const email = getSyncEmail()!;
  const authPw = await deriveAuthPassword(masterPassword);
  try {
    storeSession(
      await authPost("/auth/v1/token?grant_type=password", {
        email,
        password: authPw,
      }),
    );
  } catch {
    // no account yet (or wrong password) — try creating it
    const d = await authPost("/auth/v1/signup", { email, password: authPw });
    if (!d.access_token)
      throw new Error(
        "account needs email confirmation — disable 'Confirm email' in Supabase Auth settings",
      );
    storeSession(d);
  }
}

async function freshToken(): Promise<Session> {
  let s = getSession();
  if (!s) throw new Error("Not signed in");
  if (s.expires_at - 60 < Date.now() / 1000) {
    storeSession(
      await authPost("/auth/v1/token?grant_type=refresh_token", {
        refresh_token: s.refresh_token,
      }),
    );
    s = getSession()!;
  }
  return s;
}

// --- blob push/pull -----------------------------------------------------------------

async function rest(path: string, init: RequestInit = {}): Promise<Response> {
  const s = await freshToken();
  return fetch(`${URL}/rest/v1${path}`, {
    ...init,
    headers: {
      apikey: ANON!,
      Authorization: `Bearer ${s.access_token}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

export async function pullVault(): Promise<VaultFile | null> {
  const res = await rest("/vaults?select=blob&limit=1");
  if (!res.ok) throw new Error(`pull failed (${res.status})`);
  const rows = (await res.json()) as Array<{ blob: VaultFile }>;
  return rows[0]?.blob ?? null;
}

export async function pushVault(v: VaultFile): Promise<void> {
  const s = await freshToken();
  const res = await rest("/vaults", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify([{ user_id: s.user_id, blob: v, updated_at: v.updatedAt }]),
  });
  if (!res.ok) throw new Error(`push failed (${res.status})`);
}

/** Last-write-wins reconciliation between the local and remote vault files. */
export async function syncVault(
  local: VaultFile | null,
): Promise<{ vault: VaultFile | null; action: "pulled" | "pushed" | "in-sync" }> {
  const remote = await pullVault();
  if (remote && (!local || remote.updatedAt > local.updatedAt))
    return { vault: remote, action: "pulled" };
  if (local && (!remote || local.updatedAt > remote.updatedAt)) {
    await pushVault(local);
    return { vault: local, action: "pushed" };
  }
  return { vault: local, action: "in-sync" };
}
