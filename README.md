# Password Manager

Local-first, zero-knowledge password manager. See `Password_Manager__Build_Blueprint.pdf` for the full design.

## Status

- ✅ Layer 1 — vault core (`src/vault.ts`): PBKDF2-SHA256 600k + AES-256-GCM, unit-tested
- ✅ Layer 2 — web UI: lock screen, list, edit modal; deploy workflow ready
- ✅ Layer 3 — Tauri Mac app scaffold (`src-tauri/`), vault file on disk
- ✅ Layer 4 — Supabase blob sync (last-write-wins), generator, strength meter, clipboard clear, keep-alive cron

## Try it (web)

```sh
npm install
npm run dev    # open the printed URL, create a vault
npm test       # vault crypto tests
npm run build  # type-check + production build → dist/
```

## Deploy to GitHub Pages

Push to a **public** GitHub repo, then Settings → Pages → source: **GitHub Actions**. `deploy.yml` tests, builds, and publishes on every push to `main`.

## Mac app (Layer 3)

One-time setup on your Mac:

```sh
xcode-select --install                                     # Apple build tools
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh   # Rust
npx tauri icon app-icon.png                                # generate icon set
```

Then `npm run tauri dev` to run, or `npm run tauri build` — the `.app` lands in `src-tauri/target/release/bundle/macos/`, drag it to Applications. No Apple Developer fee. The vault lives in `~/Library/Application Support/com.ning.passwordmanager/vault.json`.

## Sync (Layer 4)

Off by default; the app is fully local without it.

1. Create a free project at supabase.com
2. Run `supabase/setup.sql` in the SQL Editor (table + row-level security)
3. Copy `.env.example` → `.env`, fill in your project URL + anon key, rebuild
4. In the app: Settings → Sync email. The email is stored only in that browser/device. Syncs on unlock and after every save
5. For the deployed site: set `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` as repo **variables** (Actions)
6. Keep-alive: set `SUPABASE_URL` / `SUPABASE_ANON_KEY` as repo **secrets** — `keepalive.yml` pings every 3 days so the free project never pauses

The server only ever stores the encrypted blob. The sync account password is separate from your master password; the master password never leaves the device.

If two devices use different master passwords, pull is refused ("different master password") — make sure both vaults were created with the same one.

## Shortcuts

`↑↓` move · `⏎` copy password · `⌘⏎` copy username · `⌘E` edit · `⌘N` new · `⌘L` lock

⚠️ Learning build — keep real high-stakes passwords in a battle-tested manager until this has been hardened and reviewed.
