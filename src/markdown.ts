/**
 * markdown.ts — export the vault as a standard, human-editable Markdown file.
 * One "## Title" section per entry with "- Field: value" bullets. The format
 * is intentionally readable AND re-importable (see import.ts block parser), so
 * you can export, edit, and bring the changes back in.
 *
 * Plaintext: the exported file contains real passwords. Pure — no DOM/crypto.
 */

import type { Entry } from "./vault";

export function toMarkdown(entries: Entry[], exportedAt: Date = new Date()): string {
  const out: string[] = [];
  out.push("# My Vault export");
  out.push("");
  out.push(
    `_Exported ${exportedAt.toISOString().slice(0, 10)} — plaintext, keep this file safe._`,
  );
  out.push("");
  for (const e of entries) {
    out.push(`## ${e.title || "(untitled)"}`);
    if (e.username) out.push(`- Username: ${e.username}`);
    if (e.password) out.push(`- Password: ${e.password}`);
    if (e.keywords.length) out.push(`- Keywords: ${e.keywords.join(", ")}`);
    if (e.notes) out.push(`- Notes: ${e.notes.replace(/\r?\n/g, " ")}`);
    out.push("");
  }
  return out.join("\n").replace(/\n+$/, "\n");
}

export function exportFilename(exportedAt: Date = new Date()): string {
  return `vault-export-${exportedAt.toISOString().slice(0, 10)}.md`;
}
