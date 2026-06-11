/**
 * sync.ts — Layer 4: Supabase encrypted-blob sync, last-write-wins.
 *
 * The server only ever sees the opaque VaultFile (ciphertext + public KDF
 * params). Plain fetch against Supabase's REST APIs — no SDK needed.
 * Sync is a bolt-on: if env vars are missing or the DB is paused, the app
 * works fine from local storage.
 *
 * Setup: supabase/setup.sql + .env.example
 */

import type { VaultFile } from "./vault";

const URL: string | undefined = import.meta.env.VITE_SUPABASE_URL;
const ANON: string | undefined = import.meta.env.VITE_SUPABASE_ANON_KEY;

/** True when the build was configured with a Supabase project. */
export const syncEnabled: boolean = Boolean(URL && ANON);

// --- session (Supabase Auth, stored locally) --------------------------------

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
  return syncEnabled && getSession() !== null;
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

/** Sign in with the Supabase account (NOT the master password). */
export async function signIn(email: string, password: string): Promise<void> {
  storeSession(await authPost("/auth/v1/token?grant_type=password", { email, password }));
}

export async function signUp(email: string, password: string): Promise<void> {
  const d = await authPost("/auth/v1/signup", { email, password });
  if (d.access_token) storeSession(d);
  else throw new Error("Account created — confirm via the email link, then sign in.");
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

// --- blob push/pull ----------------------------------------------------------

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
