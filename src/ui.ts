/**
 * ui.ts — render(state). Three screens: locked | list | editing (modal over list),
 * plus an optional sync sign-in modal. Vanilla DOM, full re-render per state
 * change; main.ts owns state + actions.
 */

import type { Entry } from "./vault";

export type Screen =
  | {
      kind: "locked";
      mode: "unlock" | "create";
      busy: boolean;
      error: string | null;
      syncAvailable: boolean;
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
}

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

export function render(root: HTMLElement, s: Screen, a: Actions): void {
  if (s.kind === "locked") return renderLock(root, s, a);
  renderList(root, s, a);
  if (s.editing) renderModal(root, s.editing, a);
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
      ${create && s.syncAvailable ? `<button type="button" id="restore" ${s.busy ? "disabled" : ""} title="type your master password above, then click">⇅ Restore from sync</button>` : ""}
      ${s.toast ? `<div class="toast">${esc(s.toast)}</div>` : ""}
    </div>`;
  const form = root.querySelector<HTMLFormElement>("#lock-form")!;
  const pw = root.querySelector<HTMLInputElement>("#pw")!;
  pw.focus();
  const restoreBtn = root.querySelector<HTMLButtonElement>("#restore");
  if (restoreBtn) restoreBtn.onclick = () => a.restore(pw.value);
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
      return `
      <div class="row ${i === s.selected ? "selected" : ""}" data-i="${i}">
        <span class="title">${esc(e.title)}</span>
        <span class="user">${esc(e.username)}</span>
        <span class="pw">${revealed ? esc(e.password) : "••••••"}</span>
        <button class="reveal" data-i="${i}" title="hold to reveal">👁</button>
        <button class="copy" data-i="${i}" title="copy password">📋</button>
      </div>`;
    })
    .join("");

  root.innerHTML = `
    <div class="topbar">
      <input id="search" type="search" placeholder="🔍 search…" autocomplete="off" value="${esc(s.query)}" />
      <button id="new">+ New</button>
      ${s.syncAvailable ? '<button id="sync" title="sync now">⇅</button>' : ""}
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
  root.querySelector<HTMLButtonElement>("#lock")!.onclick = () => a.lock();
  const syncBtn = root.querySelector<HTMLButtonElement>("#sync");
  if (syncBtn) syncBtn.onclick = () => a.runSync();

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
}

// --- 3. add/edit modal -----------------------------------------------------------

function renderModal(root: HTMLElement, editing: Entry | "new", a: Actions): void {
  const e: Entry =
    editing === "new"
      ? { id: "", title: "", username: "", password: "", keywords: [] }
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
  };
  renderChips();

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
    });
  };
  $("#m-save").onclick = save;
  $("#m-cancel").onclick = () => a.closeEdit();
  const del = overlay.querySelector<HTMLButtonElement>("#m-del");
  if (del)
    del.onclick = () => {
      if (confirm(`Delete "${e.title}"? This cannot be undone.`)) a.deleteEntry(e.id);
    };

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

