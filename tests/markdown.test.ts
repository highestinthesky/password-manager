import { describe, it, expect } from "vitest";
import { toMarkdown, exportFilename } from "../src/markdown";
import { parseImport } from "../src/import";
import type { Entry } from "../src/vault";

const entries: Entry[] = [
  { id: "1", title: "GitHub", username: "haolun.z", password: "s3cret", keywords: ["dev", "code"], updatedAt: 1 },
  { id: "2", title: "Steam", username: "", password: "p@ss|w0rd^{~}", keywords: [], notes: "backup code 8842", updatedAt: 2 },
  { id: "3", title: "vhl central", username: "", password: "aaa-bbb-ccc", keywords: ["school"], updatedAt: 3 },
];

// import produces drafts (no id / sync metadata) — strip those for comparison
const stripMeta = (e: Entry) => {
  const { id: _id, updatedAt: _u, deleted: _d, ...rest } = e;
  return rest;
};

describe("markdown export", () => {
  it("round-trips through the importer (ids aside)", () => {
    const md = toMarkdown(entries, new Date("2026-06-14T00:00:00Z"));
    const { entries: back, format } = parseImport(md);
    expect(format).toBe("blocks");
    expect(back).toEqual(entries.map(stripMeta));
  });

  it("produces standard markdown headings and bullets", () => {
    const md = toMarkdown(entries, new Date("2026-06-14T00:00:00Z"));
    expect(md).toContain("## GitHub");
    expect(md).toContain("- Username: haolun.z");
    expect(md).toContain("- Keywords: dev, code");
    expect(md).toContain("- Notes: backup code 8842");
  });

  it("omits empty fields", () => {
    const md = toMarkdown([{ id: "x", title: "Bare", username: "", password: "pw", keywords: [], updatedAt: 1 }]);
    expect(md).toContain("## Bare");
    expect(md).not.toContain("- Username:");
    expect(md).not.toContain("- Keywords:");
    expect(md).not.toContain("- Notes:");
  });

  it("dates the export filename", () => {
    expect(exportFilename(new Date("2026-06-14T00:00:00Z"))).toBe("vault-export-2026-06-14.md");
  });
});
