import lockedPng from "./assets/vault-locked.png?url";
import unlockedPng from "./assets/vault-unlocked.png?url";

type IconState = "locked" | "unlocked";

let currentState: IconState | null = null;
let nativeRequest = 0;

export function setVaultIcon(open: boolean): void {
  const state: IconState = open ? "unlocked" : "locked";
  if (state === currentState) return;
  currentState = state;

  const href = open ? unlockedPng : lockedPng;
  setFavicon(href);
  void setNativeIcon(href, ++nativeRequest);
}

function setFavicon(href: string): void {
  const selector = 'link[rel="icon"][data-vault-state-icon="true"]';
  let link = document.querySelector<HTMLLinkElement>(selector);
  if (!link) {
    link = document.createElement("link");
    link.rel = "icon";
    link.type = "image/png";
    link.dataset.vaultStateIcon = "true";
    document.head.appendChild(link);
  }
  link.href = href;
}

async function setNativeIcon(href: string, requestId: number): Promise<void> {
  if (!("__TAURI_INTERNALS__" in window)) return;

  try {
    const res = await fetch(href);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const { invoke } = await import("@tauri-apps/api/core");
    if (requestId !== nativeRequest) return;
    await invoke("set_app_icon", { bytes: Array.from(bytes) });
  } catch {
    // Icon changes are cosmetic; keep the vault workflow quiet if the platform refuses.
  }
}
