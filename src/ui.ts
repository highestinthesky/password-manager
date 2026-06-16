/**
 * ui.ts — render(state). Three screens: locked | list | editing (modal over list),
 * plus an optional sync sign-in modal. Vanilla DOM, full re-render per state
 * change; main.ts owns state + actions.
 */

import type { Entry } from "./vault";
import { parseImport } from "./import";
import { suggestKeywords } from "./keywords";
import { AUTO_LOCK_OPTIONS, CLIPBOARD_OPTIONS } from "./prefs";

export type Screen =
  | {
      kind: "locked";
      mode: "unlock" | "create";
      busy: boolean;
      error: string | null;
      syncConfigured: boolean;
      syncAvailable: boolean;
      syncEmail: string | null;
      toast: string | null;
    }
  | {
      kind: "list";
      entries: Entry[]; // already filtered
      query: string;
      selected: number;
      revealedId: string | null;
      editing: Entry | "new" | null;
      toast: string | null;
      syncAvailable: boolean;
      syncEmail: string | null;
      settings: boolean;
      importing: boolean;
      autoLockMs: number;
      clipboardClearMs: number;
      entryCount: number;
      appVersion: string;
    };

export interface Actions {
  unlock(password: string): void;
  create(password: string, confirm: string): void;
  lock(): void;
  setQuery(q: string): void;
  select(i: number): void;
  copyPassword(e: Entry): void;
  copyUsername(e: Entry): void;
  revealStart(e: Entry): void;
  revealEnd(): void;
  openEdit(e: Entry | "new"): void;
  closeEdit(): void;
  saveEntry(e: Entry): void;
  deleteEntry(id: string): void;
  generatePassword(): string;
  restore(masterPassword: string): void;
  runSync(): void;
  openSettings(): void;
  closeSettings(): void;
  saveSyncEmail(email: string): void;
  openImport(): void;
  closeImport(): void;
  importEntries(text: string): void;
  setAutoLock(ms: number): void;
  setClipboardClear(ms: number): void;
  exportMarkdown(): void;
}

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

export function render(root: HTMLElement, s: Screen, a: Actions): void {
  if (s.kind === "locked") return renderLock(root, s, a);
  renderList(root, s, a);
  if (s.editing) renderModal(root, s.editing, a);
  if (s.settings) renderSettings(root, s, a);
  if (s.importing) renderImport(root, a);
}

// --- password strength (used by edit modal) ---------------------------------

export function strength(pw: string): { pct: number; label: string; color: string } {
  if (!pw) return { pct: 0, label: "", color: "transparent" };
  let pool = 0;
  if (/[a-z]/.test(pw)) pool += 26;
  if (/[A-Z]/.test(pw)) pool += 26;
  if (/[0-9]/.test(pw)) pool += 10;
  if (/[^a-zA-Z0-9]/.test(pw)) pool += 32;
  const bits = pw.length * Math.log2(pool || 1);
  if (bits < 40) return { pct: 25, label: "weak", color: "#d33" };
  if (bits < 60) return { pct: 50, label: "fair", color: "#e69b00" };
  if (bits < 80) return { pct: 75, label: "good", color: "#7ab648" };
  return { pct: 100, label: "strong", color: "#2e9e44" };
}

// --- 1. lock screen ----------------------------------------------------------

function renderLock(
  root: HTMLElement,
  s: Extract<Screen, { kind: "locked" }>,
  a: Actions,
): void {
  const create = s.mode === "create";
  root.innerHTML = `
    <div class="lock">
      <div style="font-size:2.5rem">🔒</div>
      <h1>My Vault</h1>
      <form id="lock-form" ${s.error ? 'class="shake"' : ""}>
        <input id="pw" type="password" placeholder="master password"
               autocomplete="off" ${s.busy ? "disabled" : ""} />
        ${create ? `<input id="pw2" type="password" placeholder="confirm password" autocomplete="off" ${s.busy ? "disabled" : ""} />` : ""}
        <button class="primary" type="submit" ${s.busy ? "disabled" : ""}>
          ${create ? "Create vault" : "Unlock"}
        </button>
      </form>
      <div class="status ${s.error ? "error" : ""}">
        ${s.busy ? "deriving key… ▓▓▓░░" : s.error ? esc(s.error) : create ? "First run — choose a master password" : ""}
      </div>
      ${create && s.syncConfigured ? `
        <div class="lock-sync">
          <input id="sync-email" type="email" value="${esc(s.syncEmail ?? "")}"
                 placeholder="sync email" autocomplete="email" ${s.busy ? "disabled" : ""} />
          <button type="button" id="save-sync-email" ${s.busy ? "disabled" : ""}>Save sync email</button>
        </div>` : ""}
      ${create && s.syncAvailable ? `<button type="button" id="restore" ${s.busy ? "disabled" : ""} title="type your master password above, then click">⇅ Restore from sync</button>` : ""}
      ${s.toast ? `<div class="toast">${esc(s.toast)}</div>` : ""}
    </div>`;
  const form = root.querySelector<HTMLFormElement>("#lock-form")!;
  const pw = root.querySelector<HTMLInputElement>("#pw")!;
  pw.focus();
  const restoreBtn = root.querySelector<HTMLButtonElement>("#restore");
  if (restoreBtn) restoreBtn.onclick = () => a.restore(pw.value);
  const syncEmail = root.querySelector<HTMLInputElement>("#sync-email");
  const saveSyncEmail = root.querySelector<HTMLButtonElement>("#save-sync-email");
  if (syncEmail && saveSyncEmail) {
    const save = () => {
      const email = syncEmail.value.trim().toLowerCase();
      if (!email || !email.includes("@")) {
        syncEmail.focus();
        return;
      }
      a.saveSyncEmail(email);
    };
    saveSyncEmail.onclick = save;
    syncEmail.onkeydown = (ev) => {
      if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) {
        ev.preventDefault();
        save();
      }
    };
  }
  form.onsubmit = (ev) => {
    ev.preventDefault();
    const pw2 = root.querySelector<HTMLInputElement>("#pw2");
    if (create) a.create(pw.value, pw2?.value ?? "");
    else a.unlock(pw.value);
  };
}

// --- 2. list -------------------------------------------------------------------

function renderList(
  root: HTMLElement,
  s: Extract<Screen, { kind: "list" }>,
  a: Actions,
): void {
  const rows = s.entries
    .map((e, i) => {
      const revealed = s.revealedId === e.id;
      const kws = e.keywords.length
        ? `<div class="row-kws">${e.keywords
            .map((k) => `<button class="kwchip" data-kw="${esc(k)}" title="filter by ${esc(k)}">${esc(k)}</button>`)
            .join("")}</div>`
        : "";
      return `
      <div class="row ${i === s.selected ? "selected" : ""}" data-i="${i}">
        <div class="row-top">
          <span class="title">${esc(e.title)}</span>
          <span class="user">${esc(e.username)}</span>
          <span class="pw">${revealed ? esc(e.password) : "••••••"}</span>
          <button class="reveal" data-i="${i}" title="hold to reveal">👁</button>
          <button class="copy" data-i="${i}" title="copy password">📋</button>
        </div>
        ${kws}
      </div>`;
    })
    .join("");

  root.innerHTML = `
    <div class="topbar">
      <input id="search" type="search" placeholder="🔍 search…" autocomplete="off" value="${esc(s.query)}" />
      <button id="new">+ New</button>
      <button id="import" title="import passwords (⌘I)">⬇</button>
      ${s.syncAvailable ? '<button id="sync" title="sync now">⇅</button>' : ""}
      <button id="settings" title="settings">⚙</button>
      <button id="lock" title="lock (⌘L)">🔒</button>
    </div>
    <div class="rows">${rows || `<div class="empty">${s.query ? "No matches" : "Empty vault — add your first entry"}</div>`}</div>
    <div class="hints">
      <kbd>↑↓</kbd> move · <kbd>⏎</kbd> copy password · <kbd>⌘⏎</kbd> copy username · <kbd>⌘E</kbd> edit · <kbd>⌘L</kbd> lock
    </div>
    ${s.toast ? `<div class="toast">${esc(s.toast)}</div>` : ""}`;

  const search = root.querySelector<HTMLInputElement>("#search")!;
  search.focus();
  search.setSelectionRange(search.value.length, search.value.length);
  search.oninput = () => a.setQuery(search.value);

  root.querySelector<HTMLButtonElement>("#new")!.onclick = () => a.openEdit("new");
  root.querySelector<HTMLButtonElement>("#import")!.onclick = () => a.openImport();
  root.querySelector<HTMLButtonElement>("#lock")!.onclick = () => a.lock();
  const syncBtn = root.querySelector<HTMLButtonElement>("#sync");
  if (syncBtn) syncBtn.onclick = () => a.runSync();
  root.querySelector<HTMLButtonElement>("#settings")!.onclick = () => a.openSettings();

  root.querySelectorAll<HTMLButtonElement>(".copy").forEach((b) => {
    b.onclick = (ev) => {
      ev.stopPropagation();
      a.copyPassword(s.entries[Number(b.dataset.i)]!);
    };
  });
  root.querySelectorAll<HTMLButtonElement>(".reveal").forEach((b) => {
    const entry = s.entries[Number(b.dataset.i)]!;
    b.onpointerdown = (ev) => {
      ev.stopPropagation();
      a.revealStart(entry);
    };
    b.onpointerup = b.onpointerleave = () => a.revealEnd();
  });
  root.querySelectorAll<HTMLDivElement>(".row").forEach((r) => {
    r.onclick = () => a.select(Number(r.dataset.i));
    r.ondblclick = () => a.openEdit(s.entries[Number(r.dataset.i)]!);
  });
  root.querySelectorAll<HTMLButtonElement>(".kwchip").forEach((b) => {
    b.onclick = (ev) => {
      ev.stopPropagation();
      a.setQuery(b.dataset.kw ?? "");
    };
  });
}

// --- 3. add/edit modal -----------------------------------------------------------

function renderModal(root: HTMLElement, editing: Entry | "new", a: Actions): void {
  const e: Entry =
    editing === "new"
      ? { id: "", title: "", username: "", password: "", keywords: [], updatedAt: 0 }
      : editing;
  const keywords = [...e.keywords];

  const overlay = document.createElement("div");
  overlay.className = "overlay";
  overlay.innerHTML = `
    <div class="modal">
      <h2 style="margin:0;font-size:1.1rem">${editing === "new" ? "New entry" : "Edit entry"}</h2>
      <label>Title <input id="m-title" value="${esc(e.title)}" /></label>
      <label>Username <input id="m-user" value="${esc(e.username)}" autocomplete="off" /></label>
      <label>Password
        <span class="field-row">
          <input id="m-pass" type="password" value="${esc(e.password)}" autocomplete="off" />
          <button type="button" id="m-gen" title="generate">🎲</button>
          <button type="button" id="m-eye" title="show/hide">👁</button>
        </span>
        <span class="meter"><span class="meter-fill" id="m-meter"></span></span>
        <span class="meter-label" id="m-meter-label"></span>
      </label>
      <label>Keywords
        <span class="chips" id="m-chips">
          <input id="m-kw" placeholder="add… (⏎ or ,)" autocomplete="off" />
        </span>
      </label>
      <div class="suggest" id="m-suggest"></div>
      <label>Notes <textarea id="m-notes" rows="2">${esc(e.notes ?? "")}</textarea></label>
      <div class="actions">
        <span>${editing !== "new" ? '<button type="button" id="m-del" class="danger">Delete</button>' : ""}</span>
        <span class="right">
          <button type="button" id="m-cancel">Cancel</button>
          <button type="button" id="m-save" class="primary">Save</button>
        </span>
      </div>
    </div>`;
  root.appendChild(overlay);

  const $ = <T extends HTMLElement>(sel: string) => overlay.querySelector<T>(sel)!;
  const title = $<HTMLInputElement>("#m-title");
  const user = $<HTMLInputElement>("#m-user");
  const pass = $<HTMLInputElement>("#m-pass");
  const kwInput = $<HTMLInputElement>("#m-kw");
  const chips = $<HTMLSpanElement>("#m-chips");
  title.focus();

  const meter = $<HTMLSpanElement>("#m-meter");
  const meterLabel = $<HTMLSpanElement>("#m-meter-label");
  const updateMeter = () => {
    const st = strength(pass.value);
    meter.style.width = `${st.pct}%`;
    meter.style.background = st.color;
    meterLabel.textContent = st.label;
  };
  updateMeter();
  pass.oninput = updateMeter;

  const suggestBox = $<HTMLDivElement>("#m-suggest");
  const notesEl = $<HTMLTextAreaElement>("#m-notes");

  const renderChips = () => {
    chips.querySelectorAll(".chip").forEach((c) => c.remove());
    for (const [i, kw] of keywords.entries()) {
      const chip = document.createElement("span");
      chip.className = "chip";
      chip.innerHTML = `${esc(kw)}<button type="button" title="remove">×</button>`;
      chip.querySelector("button")!.onclick = () => {
        keywords.splice(i, 1);
        renderChips();
      };
      chips.insertBefore(chip, kwInput);
    }
    renderSuggestions();
  };

  // Local, one-tap keyword suggestions (never auto-applied).
  const renderSuggestions = () => {
    const sugg = suggestKeywords(
      { title: title.value, username: user.value, notes: notesEl.value },
      keywords,
    );
    if (!sugg.length) {
      suggestBox.innerHTML = "";
      return;
    }
    suggestBox.innerHTML =
      `<span class="suggest-label">Suggested:</span>` +
      sugg
        .map((k) => `<button type="button" class="suggest-chip" data-kw="${esc(k)}">+ ${esc(k)}</button>`)
        .join("");
    suggestBox.querySelectorAll<HTMLButtonElement>(".suggest-chip").forEach((b) => {
      b.onclick = () => {
        const kw = b.dataset.kw ?? "";
        if (kw && !keywords.includes(kw)) keywords.push(kw);
        renderChips();
      };
    });
  };

  renderChips();
  title.oninput = renderSuggestions;
  user.oninput = renderSuggestions;

  const commitKeyword = () => {
    const v = kwInput.value.trim().replace(/,$/, "").trim();
    if (v && !keywords.includes(v)) keywords.push(v);
    kwInput.value = "";
    renderChips();
  };
  kwInput.onkeydown = (ev) => {
    if (ev.key === "Enter" || ev.key === ",") {
      ev.preventDefault();
      commitKeyword();
    } else if (ev.key === "Backspace" && !kwInput.value && keywords.length) {
      keywords.pop();
      renderChips();
    }
  };

  $("#m-gen").onclick = () => {
    pass.value = a.generatePassword();
    pass.type = "text";
    updateMeter();
  };
  $("#m-eye").onclick = () => {
    pass.type = pass.type === "password" ? "text" : "password";
  };

  const save = () => {
    commitKeyword();
    if (!title.value.trim()) {
      title.focus();
      return;
    }
    a.saveEntry({
      id: e.id || crypto.randomUUID(),
      title: title.value.trim(),
      username: user.value.trim(),
      password: pass.value,
      keywords,
      notes: $<HTMLTextAreaElement>("#m-notes").value.trim() || undefined,
      updatedAt: Date.now(), // main re-stamps on save; required by the type
    });
  };
  $("#m-save").onclick = save;
  $("#m-cancel").onclick = () => a.closeEdit();
  // two-click confirm — native confirm() dialogs don't work in Tauri's webview
  const del = overlay.querySelector<HTMLButtonElement>("#m-del");
  if (del) {
    let armed = false;
    del.onclick = () => {
      if (!armed) {
        armed = true;
        del.textContent = "Really delete?";
        return;
      }
      a.deleteEntry(e.id);
    };
  }

  overlay.onkeydown = (ev) => {
    if (ev.key === "Escape") {
      ev.stopPropagation();
      a.closeEdit();
    } else if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) {
      ev.preventDefault();
      save();
    }
  };
  overlay.onclick = (ev) => {
    if (ev.target === overlay) a.closeEdit();
  };
}

// --- 4. settings modal -------------------------------------------------------------

function fmtLock(ms: number): string {
  const m = ms / 60_000;
  return m >= 1 ? `${m} min` : `${ms / 1000} s`;
}
function fmtSec(ms: number): string {
  return `${ms / 1000} s`;
}

function renderSettings(
  root: HTMLElement,
  s: Extract<Screen, { kind: "list" }>,
  a: Actions,
): void {
  const overlay = document.createElement("div");
  overlay.className = "overlay";
  const lockOpts = AUTO_LOCK_OPTIONS.map(
    (ms) => `<option value="${ms}" ${ms === s.autoLockMs ? "selected" : ""}>${fmtLock(ms)}</option>`,
  ).join("");
  const clipOpts = CLIPBOARD_OPTIONS.map(
    (ms) => `<option value="${ms}" ${ms === s.clipboardClearMs ? "selected" : ""}>${fmtSec(ms)}</option>`,
  ).join("");
  overlay.innerHTML = `
    <div class="modal">
      <h2 style="margin:0;font-size:1.1rem">⚙ Settings</h2>

      <div class="set-section">Security</div>
      <label>Auto-lock after
        <select id="set-lock">${lockOpts}</select>
      </label>
      <label>Clear clipboard after
        <select id="set-clip">${clipOpts}</select>
      </label>

      <div class="set-section">Sync</div>
      <label>Sync email
        <input id="set-email" type="email" value="${esc(s.syncEmail ?? "")}" autocomplete="off" placeholder="you@example.com" />
      </label>
      <p class="set-hint">
        Identifier for your sync account. Changing it switches accounts — your local
        vault is pushed there on the next sync. The account password is derived from
        your master password automatically.
      </p>

      <div class="set-section">Vault</div>
      <div class="set-stats">
        <span>${s.entryCount} ${s.entryCount === 1 ? "entry" : "entries"}</span>
        <span>Sync: ${s.syncAvailable ? "on" : "off"}</span>
        <span>v${esc(s.appVersion)}</span>
      </div>
      <button type="button" id="set-export">⬇ Export all to Markdown…</button>

      <div class="actions">
        <span></span>
        <span class="right">
          <button type="button" id="set-cancel">Close</button>
          <button type="button" id="set-save" class="primary">Save email</button>
        </span>
      </div>
    </div>`;
  root.appendChild(overlay);

  const $ = <T extends HTMLElement>(sel: string) => overlay.querySelector<T>(sel)!;
  const email = $<HTMLInputElement>("#set-email");
  email.focus();

  $<HTMLSelectElement>("#set-lock").onchange = (ev) =>
    a.setAutoLock(Number((ev.target as HTMLSelectElement).value));
  $<HTMLSelectElement>("#set-clip").onchange = (ev) =>
    a.setClipboardClear(Number((ev.target as HTMLSelectElement).value));

  // two-step confirm — export writes plaintext to disk
  const exportBtn = $<HTMLButtonElement>("#set-export");
  let armed = false;
  exportBtn.onclick = () => {
    if (!armed) {
      armed = true;
      exportBtn.textContent = "⚠ Writes plaintext — click to confirm";
      exportBtn.classList.add("danger");
      return;
    }
    a.exportMarkdown();
  };

  const saveEmail = () => {
    const v = email.value.trim().toLowerCase();
    if (!v || !v.includes("@")) {
      email.focus();
      return;
    }
    if (v === (s.syncEmail ?? "")) {
      a.closeSettings();
      return;
    }
    a.saveSyncEmail(v);
  };
  $<HTMLButtonElement>("#set-save").onclick = saveEmail;
  $<HTMLButtonElement>("#set-cancel").onclick = () => a.closeSettings();
  overlay.onkeydown = (ev) => {
    if (ev.key === "Escape") {
      ev.stopPropagation();
      a.closeSettings();
    }
  };
  overlay.onclick = (ev) => {
    if (ev.target === overlay) a.closeSettings();
  };
}

// --- 5. import modal ---------------------------------------------------------------

function renderImport(root: HTMLElement, a: Actions): void {
  const overlay = document.createElement("div");
  overlay.className = "overlay";
  overlay.innerHTML = `
    <div class="modal wide">
      <h2 style="margin:0;font-size:1.1rem">⬇ Import passwords</h2>
      <label>Paste a CSV export or one entry per line
        <textarea id="imp-text" rows="8" autocomplete="off" spellcheck="false"
          placeholder="Example Site:&#10;example-password&#10;&#10;Another Account:&#10;another-password&#10;&#10;— or CSV —&#10;title,username,password"></textarea>
      </label>
      <div id="imp-preview" class="import-preview"></div>
      <p style="margin:0;font-size:0.78rem;color:var(--muted)">
        Reads CSV exports (Chrome, Safari, Bitwarden, 1Password), one-per-line
        lists, or name / password blocks separated by blank lines. Nothing is
        saved until you click Import.
      </p>
      <div class="actions">
        <span></span>
        <span class="right">
          <button type="button" id="imp-cancel">Cancel</button>
          <button type="button" id="imp-save" class="primary" disabled>Import</button>
        </span>
      </div>
    </div>`;
  root.appendChild(overlay);

  const ta = overlay.querySelector<HTMLTextAreaElement>("#imp-text")!;
  const preview = overlay.querySelector<HTMLDivElement>("#imp-preview")!;
  const saveBtn = overlay.querySelector<HTMLButtonElement>("#imp-save")!;
  ta.focus();

  const update = () => {
    const { entries, format } = parseImport(ta.value);
    saveBtn.disabled = entries.length === 0;
    saveBtn.textContent = entries.length ? `Import ${entries.length}` : "Import";
    if (!ta.value.trim()) {
      preview.innerHTML = "";
      return;
    }
    if (entries.length === 0) {
      preview.innerHTML = `<div class="import-note">Couldn't parse any entries — check the format.</div>`;
      return;
    }
    const shown = entries.slice(0, 8);
    const rows = shown
      .map(
        (e) => `<tr>
          <td>${esc(e.title)}</td>
          <td class="muted">${esc(e.username) || "—"}</td>
          <td class="muted mono">${e.password ? "••••••" : "—"}</td>
        </tr>`,
      )
      .join("");
    const more =
      entries.length > shown.length
        ? `<div class="import-note">+ ${entries.length - shown.length} more</div>`
        : "";
    preview.innerHTML = `
      <div class="import-count">${entries.length} ${entries.length === 1 ? "entry" : "entries"} detected · ${format.toUpperCase()}</div>
      <table class="import-table">
        <thead><tr><th>Title</th><th>Username</th><th>Password</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>${more}`;
  };
  ta.oninput = update;
  update();

  saveBtn.onclick = () => a.importEntries(ta.value);
  overlay.querySelector<HTMLButtonElement>("#imp-cancel")!.onclick = () => a.closeImport();
  overlay.onkeydown = (ev) => {
    if (ev.key === "Escape") {
      ev.stopPropagation();
      a.closeImport();
    } else if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey) && !saveBtn.disabled) {
      ev.preventDefault();
      a.importEntries(ta.value);
    }
  };
  overlay.onclick = (ev) => {
    if (ev.target === overlay) a.closeImport();
  };
}
