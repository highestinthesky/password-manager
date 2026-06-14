import { describe, it, expect } from "vitest";
import { suggestKeywords } from "../src/keywords";

describe("suggestKeywords", () => {
  it("maps a known service to a category and adds title tokens", () => {
    const s = suggestKeywords({ title: "Steam backup" });
    expect(s).toContain("games");
    expect(s).toContain("steam");
    expect(s).toContain("backup");
  });

  it("derives a category from an email-style username", () => {
    const s = suggestKeywords({ title: "Personal Mail", username: "me@gmail.com" });
    expect(s).toContain("email");
  });

  it("excludes keywords already on the entry", () => {
    const s = suggestKeywords({ title: "GitHub" }, ["dev"]);
    expect(s).not.toContain("dev");
    expect(s).toContain("github");
  });

  it("drops stopwords and short / numeric tokens", () => {
    const s = suggestKeywords({ title: "My Account 12" });
    expect(s).not.toContain("my");
    expect(s).not.toContain("account");
    expect(s).not.toContain("12");
  });

  it("caps the number of suggestions", () => {
    const s = suggestKeywords({ title: "alpha bravo charlie delta echo foxtrot golf" }, [], 4);
    expect(s.length).toBeLessThanOrEqual(4);
  });
});
