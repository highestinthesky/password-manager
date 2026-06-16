/**
 * sync.ts — Layer 4: Supabase encrypted-blob sync via the official client.
 *
 * Zero-knowledge: the Supabase account password is DERIVED from the master
 * password (PBKDF2, salt domain-separated from the vault key), so the server
 * only ever sees an opaque ciphertext blob and a derived password it can't
 * reverse. Reconciliation is entry-level merge, done in main.ts (which holds
 * the key) — this module only moves encrypted VaultFile blobs in and out and
 * relays realtime change notifications.
 *
 * Sync is a bolt-on: with no env vars (or a paused DB) the app is local-only.
 * Setup: supabase/setup.sql + .env.example.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { VaultFile } from "./vault";

const URL: string | undefined = import.meta.env.VITE_SUPABASE_URL;
const ANON: string | undefined = import.meta.env.VITE_SUPABASE_ANON_KEY;

const EMAIL_KEY = "pm.sync.email";

let client: SupabaseClient | null = null;
function sb(): SupabaseClient {
  if (!client) {
    client = createClient(URL!, ANON!, {
      auth: { persistSession: true, autoRefreshToken: true, storageKey: "pm.sb.auth" },
    });
  }
  return client;
}

/** Account identifier. Stored per browser/device so it is never baked into builds. */
export function getSyncEmail(): string | null {
  const email = localStorage.getItem(EMAIL_KEY)?.trim().toLowerCase();
  return email || null;
}

/** Changing the email switches accounts, so the old session is dropped. */
export function setSyncEmail(email: string): void {
  localStorage.setItem(EMAIL_KEY, email.trim().toLowerCase());
  signOut();
}

/** True when the shipped app has a Supabase project configured. */
export function syncConfigured(): boolean {
  return Boolean(URL && ANON);
}

/** True when configured with a Supabase project + locally saved sync email. */
export function syncEnabled(): boolean {
  return Boolean(syncConfigured() && getSyncEmail());
}

// --- auth password derivation -------------------------------------------------

/**
 * Master password → Supabase account password. Deterministic across devices,
 * domain-separated from the vault key (fixed email-based salt vs. the vault's
 * random salt), and one-way (600k PBKDF2).
 */
async function deriveAuthPassword(masterPassword: string): Promise<string> {
  const enc = new TextEncoder();
  const material = await crypto.subtle.importKey(
    "raw", enc.encode(masterPassword), "PBKDF2", false, ["deriveBits"],
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

// --- auth ---------------------------------------------------------------------

/**
 * Sign in with credentials derived from the master password. First run on an
 * account auto-creates it (requires "Confirm email" OFF in Supabase Auth, since
 * nobody ever types the derived password). The official client persists and
 * auto-refreshes the session, so this is a no-op once signed in.
 */
export async function ensureSignedIn(masterPassword: string): Promise<void> {
  if (!syncEnabled()) throw new Error("sync not configured");
  const c = sb();
  const { data: { session } } = await c.auth.getSession();
  if (session) return;

  const email = getSyncEmail()!;
  const password = await deriveAuthPassword(masterPassword);

  const signIn = await c.auth.signInWithPassword({ email, password });
  if (signIn.data.session) return;

  // No account yet (or wrong password) — try to create it.
  const signUp = await c.auth.signUp({ email, password });
  if (signUp.error) throw signUp.error;
  if (!signUp.data.session)
    throw new Error(
      "account needs email confirmation — disable 'Confirm email' in Supabase Auth settings",
    );
}

export function signOut(): void {
  if (!URL || !ANON) return;
  void sb().auth.signOut();
}

// --- blob push / pull ---------------------------------------------------------

export async function pullVault(): Promise<VaultFile | null> {
  const { data, error } = await sb()
    .from("vaults")
    .select("blob")
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data?.blob as VaultFile | undefined) ?? null;
}

export async function pushVault(v: VaultFile): Promise<void> {
  const c = sb();
  const { data: { user } } = await c.auth.getUser();
  if (!user) throw new Error("not signed in");
  const { error } = await c
    .from("vaults")
    .upsert({ user_id: user.id, blob: v, updated_at: v.updatedAt });
  if (error) throw new Error(error.message);
}

// --- realtime -----------------------------------------------------------------

/**
 * Subscribe to changes on this user's vault row. RLS scopes events to the
 * signed-in user, so we're pinged whenever another device pushes. Returns an
 * unsubscribe function. Call after ensureSignedIn so the socket is authorized.
 */
export function subscribeVault(onChange: () => void): () => void {
  const c = sb();
  const channel = c
    .channel("vault-sync")
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "vaults" },
      () => onChange(),
    )
    .subscribe();
  return () => {
    void c.removeChannel(channel);
  };
}
