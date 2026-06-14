/**
 * import.ts — parse pasted credentials into entries. Pure, zero DOM/crypto
 * dependencies (same philosophy as vault.ts) so it's fully unit-testable.
 * main.ts assigns ids and merges the result into the vault.
 *
 * Accepts two shapes, auto-detected:
 *  - CSV with a header row (Chrome, Safari/iCloud, Bitwarden, 1Password, …)
 *  - One entry per line (tab- / comma- / aligned-whitespace-separated)
 *
 * Column order for line mode: title, username, password, notes…
 */

export interface ParsedEntry {
  title: string;
  username: string;
  password: string;
  keywords: string[];
  notes?: string;
}

export type ImportFormat = "csv" | "blocks" | "lines" | "empty";

export interface ImportResult {
  entries: ParsedEntry[];
  format: ImportFormat;
}

type Field = "title" | "username" | "password" | "url" | "keywords" | "notes";
// Priority order matters: earlier fields claim an ambiguous header first.
const FIELDS: Field[] = ["title", "username", "password", "url", "keywords", "notes"];

const SYNONYMS: Record<Field, string[]> = {
  title: ["title", "name", "account", "item", "entry", "service"],
  username: [
    "username", "user", "user name", "login", "login_username",
    "login name", "email", "e-mail", "login_email", "userid", "user id",
  ],
  password: ["password", "pass", "pwd", "login_password", "passwd"],
  url: ["url", "uri", "website", "web site", "site", "login_uri", "link", "address"],
  keywords: ["keywords", "keyword", "tags", "tag", "labels", "label"],
  notes: ["notes", "note", "comment", "comments", "extra", "memo", "description"],
};

/** Split a "a, b; c" cell into a clean, de-duplicated keyword list. */
function splitKeywords(s: string): string[] {
  const out: string[] = [];
  for (const k of s.split(/[,;]/).map((x) => x.trim()).filter(Boolean)) {
    if (!out.includes(k)) out.push(k);
  }
  return out;
}

// --- CSV tokenizer (RFC-4180-ish: quotes, escaped "", embedded newlines) -----

export function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } // escaped quote
        else quoted = false;
      } else field += c;
    } else if (c === '"') {
      quoted = true;
    } else if (c === ",") {
      row.push(field); field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++; // CRLF
      row.push(field); rows.push(row);
      row = []; field = "";
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

// --- header detection / mapping ----------------------------------------------

function mapHeader(header: string[]): Partial<Record<Field, number>> {
  const idx: Partial<Record<Field, number>> = {};
  const used = new Set<number>();
  for (const field of FIELDS) {
    for (let i = 0; i < header.length; i++) {
      if (used.has(i)) continue;
      const h = (header[i] ?? "").trim().toLowerCase();
      if (SYNONYMS[field].includes(h)) {
        idx[field] = i;
        used.add(i);
        break;
      }
    }
  }
  return idx;
}

// --- helpers -----------------------------------------------------------------

function cell(row: string[], i: number | undefined): string {
  if (i === undefined) return "";
  return (row[i] ?? "").trim();
}

/** Best-effort hostname for use as a search keyword. "" when not URL-like. */
export function hostFromUrl(url: string): string {
  let u = url.trim();
  if (!u) return "";
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) u = "https://" + u;
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function fromCsvRow(
  row: string[],
  idx: Partial<Record<Field, number>>,
): ParsedEntry | null {
  const username = cell(row, idx.username);
  const password = cell(row, idx.password);
  const url = cell(row, idx.url);
  const notes = cell(row, idx.notes);
  const rawTitle = cell(row, idx.title);
  const rawKeywords = cell(row, idx.keywords);
  if (!rawTitle && !username && !password && !url && !notes && !rawKeywords) return null;

  const host = hostFromUrl(url);
  const keywords = splitKeywords(rawKeywords);
  if (host && !keywords.includes(host)) keywords.push(host);
  const title = rawTitle || host || username || "(untitled)";
  const entry: ParsedEntry = { title, username, password, keywords };
  if (notes) entry.notes = notes;
  return entry;
}

// --- line mode ---------------------------------------------------------------

type Delim = "\t" | "," | "ws";

function detectDelim(lines: string[]): Delim {
  let tab = 0, comma = 0, multi = 0;
  for (const l of lines) {
    if (l.includes("\t")) tab++;
    else if (l.includes(",")) comma++;
    else if (/\S\s{2,}\S/.test(l)) multi++;
  }
  if (tab > 0 && tab >= comma && tab >= multi) return "\t";
  if (comma > 0 && comma >= multi) return ",";
  return "ws";
}

function splitLine(line: string, d: Delim): string[] {
  if (d === "\t") return line.split("\t");
  if (d === ",") return line.split(",");
  return line.split(/\s{2,}/);
}

function parseLines(text: string): ParsedEntry[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length === 0) return [];
  const d = detectDelim(lines);
  const out: ParsedEntry[] = [];
  for (const line of lines) {
    const parts = splitLine(line, d).map((p) => p.trim());
    const title = parts[0] ?? "";
    if (!title) continue;
    const entry: ParsedEntry = {
      title,
      username: parts[1] ?? "",
      password: parts[2] ?? "",
      keywords: [],
    };
    const rest = parts.slice(3).filter(Boolean).join(" · ");
    if (rest) entry.notes = rest;
    out.push(entry);
  }
  return out;
}

// --- block mode (label line + value line(s), blocks split by blank lines) ----
//
// Handles dumps like:
//     steam backup:
//     R68214
//
//     ubisoft:
//     1N0|Ug0ik^Qy{~80
//
// First line of a block is the title (a trailing ":" is stripped); the
// remaining line(s) are the secret. Inline "username: x" / "password: y"
// lines are recognized too.

function stripLabel(line: string): string {
  return line
    .replace(/^#{1,6}\s+/, "") // markdown heading
    .replace(/^>\s+/, "") // blockquote
    .replace(/^[-*•]\s+/, "") // bullet
    .replace(/^\*\*(.+?)\*\*$/, "$1") // **bold** title
    .replace(/\s*:\s*$/, "") // trailing colon
    .trim();
}

function fieldForKey(key: string): Field | null {
  const k = key.trim().toLowerCase();
  for (const f of FIELDS) if (SYNONYMS[f].includes(k)) return f;
  return null;
}

function splitBlocks(text: string): string[][] {
  return text
    .split(/\r?\n[ \t]*\r?\n+/) // one or more blank lines (allowing trailing spaces)
    .map((b) => b.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0))
    .filter((b) => b.length > 0);
}

function parseBlocks(blocks: string[][]): ParsedEntry[] {
  const out: ParsedEntry[] = [];
  for (const block of blocks) {
    let title = "";
    let username = "";
    let password = "";
    let url = "";
    let notes = "";
    const keywords: string[] = [];
    const plain: string[] = [];

    for (const raw of block) {
      const line = raw.replace(/^[-*•]\s+/, ""); // tolerate markdown bullets
      const m = line.match(/^([A-Za-z][\w .\-/]*?)\s*[:=]\s*(.+)$/);
      const field = m ? fieldForKey(m[1]!) : null;
      if (m && field) {
        const val = m[2]!.trim();
        if (field === "username" && !username) { username = val; continue; }
        if (field === "password" && !password) { password = val; continue; }
        if (field === "title" && !title) { title = val; continue; }
        if (field === "url" && !url) { url = val; continue; }
        if (field === "notes" && !notes) { notes = val; continue; }
        if (field === "keywords") {
          for (const k of splitKeywords(val)) if (!keywords.includes(k)) keywords.push(k);
          continue;
        }
      }
      plain.push(line);
    }

    if (!title && plain.length) title = stripLabel(plain.shift()!);
    if (plain.length === 1) {
      if (!password) password = plain[0]!;
      else if (!username) username = plain[0]!;
    } else if (plain.length >= 2) {
      if (!username) username = plain[0]!;
      if (!password) password = plain[1]!;
      const extra = plain.slice(2).filter(Boolean);
      if (extra.length && !notes) notes = extra.join(" · ");
    }

    // An entry needs at least a secret or a login — this also drops markdown
    // headings/footers (title-only blocks) when re-importing an export.
    if (!password && !username) continue;
    const host = hostFromUrl(url);
    if (host && !keywords.includes(host)) keywords.push(host);
    const entry: ParsedEntry = {
      title: title || host || username || "(untitled)",
      username,
      password,
      keywords,
    };
    if (notes) entry.notes = notes;
    out.push(entry);
  }
  return out;
}

// --- entry point -------------------------------------------------------------

export function parseImport(text: string): ImportResult {
  if (!text.trim()) return { entries: [], format: "empty" };

  // Try CSV-with-header first.
  const rows = parseCSV(text).filter((r) => r.some((c) => c.trim() !== ""));
  if (rows.length >= 1) {
    const idx = mapHeader(rows[0]!);
    const looksLikeHeader =
      idx.password !== undefined &&
      (idx.title !== undefined || idx.username !== undefined);
    if (looksLikeHeader) {
      const entries: ParsedEntry[] = [];
      for (let i = 1; i < rows.length; i++) {
        const e = fromCsvRow(rows[i]!, idx);
        if (e) entries.push(e);
      }
      return { entries, format: "csv" };
    }
  }

  // Label/value blocks separated by blank lines (e.g. a Notes-style dump).
  if (/\r?\n[ \t]*\r?\n/.test(text)) {
    const blocks = splitBlocks(text);
    if (blocks.some((b) => b.length >= 2)) {
      return { entries: parseBlocks(blocks), format: "blocks" };
    }
  }

  // Fall back to one-entry-per-line.
  return { entries: parseLines(text), format: "lines" };
}
