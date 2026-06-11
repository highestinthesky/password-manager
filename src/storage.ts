/**
 * storage.ts — vault persistence.
 * Web: localStorage. Mac (Tauri): vault.json in the app data dir.
 * The rest of the app only talks to loadVault/saveVault.
 */

import type { VaultFile } from "./vault";

const KEY = "pm.vault.v1";
const FILE = "vault.json";

const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export async function loadVault(): Promise<VaultFile | null> {
  if (isTauri) {
    const { exists, readTextFile, BaseDirectory } = await import(
      "@tauri-apps/plugin-fs"
    );
    try {
      if (!(await exists(FILE, { baseDir: BaseDirectory.AppData }))) return null;
      return JSON.parse(
        await readTextFile(FILE, { baseDir: BaseDirectory.AppData }),
      ) as VaultFile;
    } catch {
      return null;
    }
  }
  const raw = localStorage.getItem(KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as VaultFile;
  } catch {
    return null;
  }
}

export async function saveVault(vault: VaultFile): Promise<void> {
  const json = JSON.stringify(vault);
  if (isTauri) {
    const { mkdir, writeTextFile, BaseDirectory } = await import(
      "@tauri-apps/plugin-fs"
    );
    try {
      await mkdir("", { baseDir: BaseDirectory.AppData, recursive: true });
    } catch {
      /* already exists */
    }
    await writeTextFile(FILE, json, { baseDir: BaseDirectory.AppData });
    return;
  }
  localStorage.setItem(KEY, json);
}
