/**
 * keywords.ts — local, deterministic keyword suggestions for the edit modal.
 * Zero network (stays zero-knowledge): suggestions come from the entry's own
 * title/username plus a small built-in map of common services → category.
 * Pure and unit-testable. main.ts/ui.ts only ever *suggest* — never auto-apply.
 */

const STOPWORDS = new Set([
  "the", "and", "for", "com", "www", "app", "account", "login", "portal",
  "official", "online", "my", "web", "site", "page", "new",
]);

// service token → category keyword
const CATEGORIES: Record<string, string[]> = {
  games: [
    "steam", "epic", "ubisoft", "ea", "origin", "riot", "valorant", "minecraft",
    "roblox", "xbox", "playstation", "psn", "nintendo", "battlenet", "blizzard",
    "gog", "itch", "rockstar",
  ],
  email: ["gmail", "outlook", "hotmail", "yahoo", "proton", "protonmail", "icloud", "fastmail", "zoho"],
  finance: [
    "chase", "paypal", "venmo", "bank", "fidelity", "schwab", "robinhood",
    "coinbase", "wellsfargo", "amex", "mastercard", "visa", "capitalone", "ally",
  ],
  social: [
    "facebook", "instagram", "twitter", "tiktok", "snapchat", "reddit",
    "discord", "linkedin", "pinterest", "tumblr", "threads", "mastodon",
  ],
  shopping: ["amazon", "ebay", "etsy", "walmart", "target", "aliexpress", "bestbuy", "shein"],
  media: ["netflix", "spotify", "hulu", "disney", "youtube", "twitch", "hbo", "crunchyroll", "primevideo"],
  dev: [
    "github", "gitlab", "bitbucket", "npm", "vercel", "netlify", "aws",
    "heroku", "digitalocean", "cloudflare", "docker", "supabase",
  ],
  school: ["canvas", "blackboard", "schoology", "powerschool", "vhl", "khan", "coursera", "edx", "duolingo"],
  work: ["slack", "zoom", "notion", "jira", "asana", "trello", "figma", "dropbox", "onedrive"],
};

const TOKEN_CATEGORY: Record<string, string> = {};
for (const [cat, tokens] of Object.entries(CATEGORIES)) {
  for (const t of tokens) TOKEN_CATEGORY[t] = cat;
}

export interface SuggestFields {
  title?: string;
  username?: string;
  notes?: string;
}

export function suggestKeywords(
  fields: SuggestFields,
  existing: string[] = [],
  max = 6,
): string[] {
  const have = new Set(existing.map((k) => k.trim().toLowerCase()));
  const out: string[] = [];
  const add = (raw: string) => {
    const k = raw.trim().toLowerCase();
    if (k.length < 3) return;
    if (have.has(k) || out.includes(k)) return;
    out.push(k);
  };

  const text = `${fields.title ?? ""} ${fields.username ?? ""}`;
  const tokens = text.split(/[^a-z0-9]+/i).map((t) => t.toLowerCase()).filter(Boolean);

  // 1) category keywords from any recognized service token (most useful first)
  for (const t of tokens) {
    const cat = TOKEN_CATEGORY[t];
    if (cat) add(cat);
  }
  // 2) meaningful title/username tokens
  for (const t of tokens) {
    if (!STOPWORDS.has(t) && !/^\d+$/.test(t)) add(t);
  }
  return out.slice(0, max);
}
