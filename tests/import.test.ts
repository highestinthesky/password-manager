import { describe, it, expect } from "vitest";
import { parseImport, parseCSV, hostFromUrl } from "../src/import";

describe("parseCSV tokenizer", () => {
  it("splits simple rows", () => {
    expect(parseCSV("a,b,c\n1,2,3")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("handles quoted fields with commas and embedded newlines", () => {
    const rows = parseCSV('name,notes\n"Acme, Inc.","line1\nline2"');
    expect(rows[1]).toEqual(["Acme, Inc.", "line1\nline2"]);
  });

  it("handles escaped quotes and CRLF", () => {
    const rows = parseCSV('a\r\n"he said ""hi"""');
    expect(rows[1]).toEqual(['he said "hi"']);
  });
});

describe("hostFromUrl", () => {
  it("strips scheme and www", () => {
    expect(hostFromUrl("https://www.github.com/login")).toBe("github.com");
    expect(hostFromUrl("github.com")).toBe("github.com");
  });
  it("returns empty for junk", () => {
    expect(hostFromUrl("")).toBe("");
    expect(hostFromUrl("not a url")).toBe("");
  });
});

describe("parseImport — CSV exports", () => {
  it("Chrome format (name,url,username,password)", () => {
    const csv =
      "name,url,username,password\n" +
      "GitHub,https://github.com,haolun.z,s3cret\n" +
      "Steam,https://steampowered.com,highestskies,pw123";
    const { entries, format } = parseImport(csv);
    expect(format).toBe("csv");
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      title: "GitHub",
      username: "haolun.z",
      password: "s3cret",
      keywords: ["github.com"],
    });
  });

  it("Bitwarden-style headers (login_username/login_password/login_uri)", () => {
    const csv =
      "folder,name,notes,login_uri,login_username,login_password\n" +
      "Personal,My Bank,call before 5pm,https://www.bank.example,me@x.com,hunter2";
    const { entries } = parseImport(csv);
    expect(entries[0]).toMatchObject({
      title: "My Bank",
      username: "me@x.com",
      password: "hunter2",
      keywords: ["bank.example"],
      notes: "call before 5pm",
    });
  });

  it("falls back to URL host as title when name is blank", () => {
    const csv = "name,url,username,password\n,https://reddit.com,u1,p1";
    const { entries } = parseImport(csv);
    expect(entries[0]!.title).toBe("reddit.com");
  });

  it("skips fully-empty rows", () => {
    const csv = "title,username,password\nA,a,1\n,,\nB,b,2";
    const { entries } = parseImport(csv);
    expect(entries.map((e) => e.title)).toEqual(["A", "B"]);
  });
});

describe("parseImport — label/value blocks (Notes-style dump)", () => {
  it("parses a blank-line-separated dump (colon, trailing space, no-colon, special chars)", () => {
    const text =
      "example one:\n" +
      "AB12-CD34\n" +
      "\n" +
      "example two:\n" +
      "p@ss|W0rd^{~}9\n" + // exercises special characters
      "\n" +
      "example three: \n" + // trailing space after the colon
      "00112233\n" +
      "\n" +
      "example four\n" + // no colon on the label line
      "aaa-bbb-ccc";
    const { entries, format } = parseImport(text);
    expect(format).toBe("blocks");
    expect(entries).toEqual([
      { title: "example one", username: "", password: "AB12-CD34", keywords: [] },
      { title: "example two", username: "", password: "p@ss|W0rd^{~}9", keywords: [] },
      { title: "example three", username: "", password: "00112233", keywords: [] },
      { title: "example four", username: "", password: "aaa-bbb-ccc", keywords: [] },
    ]);
  });

  it("handles inline key:value lines and 3-line blocks", () => {
    const text =
      "GitHub\nusername: haolun.z\npassword: s3cret\n\nBank\nme@x.com\nhunter2";
    const { entries } = parseImport(text);
    expect(entries[0]).toMatchObject({
      title: "GitHub",
      username: "haolun.z",
      password: "s3cret",
    });
    expect(entries[1]).toMatchObject({
      title: "Bank",
      username: "me@x.com",
      password: "hunter2",
    });
  });

  it("preserves special characters in passwords verbatim", () => {
    const { entries } = parseImport("example:\nN0|Ug0ik^Qy{~}8\n\nx:\ny");
    expect(entries[0]!.password).toBe("N0|Ug0ik^Qy{~}8");
  });
});

describe("parseImport — line mode", () => {
  it("comma-separated lines without a header", () => {
    const { entries, format } = parseImport("GitHub,haolun.z,s3cret\nSteam,sky,pw");
    expect(format).toBe("lines");
    expect(entries[0]).toEqual({
      title: "GitHub",
      username: "haolun.z",
      password: "s3cret",
      keywords: [],
    });
  });

  it("tab-separated lines", () => {
    const { entries } = parseImport("GitHub\thaolun.z\ts3cret");
    expect(entries[0]).toMatchObject({ title: "GitHub", username: "haolun.z", password: "s3cret" });
  });

  it("aligned-whitespace columns (titles may contain single spaces)", () => {
    const text = "school portal     hzhang26      p@ss\nSteam             sky           pw";
    const { entries } = parseImport(text);
    expect(entries[0]).toMatchObject({
      title: "school portal",
      username: "hzhang26",
      password: "p@ss",
    });
  });

  it("extra columns roll into notes", () => {
    const { entries } = parseImport("Mail,me,pw,recovery code 8842,backup");
    expect(entries[0]!.notes).toBe("recovery code 8842 · backup");
  });

  it("empty input → empty result", () => {
    expect(parseImport("   \n  ").entries).toHaveLength(0);
    expect(parseImport("").format).toBe("empty");
  });
});
