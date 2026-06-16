# Password Manager

A private password vault for storing logins, notes, and generated passwords on
your own device. The app opens as **My Vault**, stays locked behind one master
password, and only decrypts your entries while you are actively using it.

This project is local-first. You can use it without an account, and optional
sync stores only an encrypted vault blob.

## What You Can Do

- Create a vault protected by a master password.
- Save account names, usernames, passwords, keywords, and notes.
- Search by title, username, or keyword.
- Copy passwords and usernames quickly.
- Generate strong passwords when adding or editing an entry.
- Import passwords from common CSV exports or simple pasted lists.
- Export your vault to a readable Markdown file when you need a backup.
- Auto-lock the vault and clear copied passwords from the clipboard.
- Sync an encrypted copy between devices when sync is available.

## First Use

1. Open the app.
2. Choose a master password.
3. Add your first entry with **New**.
4. Use search to find an entry, then copy the password or username when needed.
5. Lock the vault when you are done.

Choose your master password carefully. It cannot be recovered or reset by the
app. If you forget it, the encrypted vault cannot be opened.

## Daily Use

Use the search field to narrow the list. Double-click an entry to edit it, or
select it and use the keyboard shortcuts below. Hold the eye button to reveal a
password temporarily.

When you copy a password or username, the app can clear it from your clipboard
after a short delay. You can change that delay in **Settings**.

## Adding And Editing Entries

Each entry can include:

- Title
- Username
- Password
- Keywords
- Notes

The password generator creates a new password for the entry you are editing.
The strength meter gives a quick estimate of password quality. Keyword
suggestions are created locally from the entry text and are never sent anywhere.

Deleting an entry removes it from the visible vault. If sync is enabled, that
delete is also carried to your other devices.

## Importing Passwords

Use **Import** to paste existing passwords into the vault. The app can read:

- CSV exports from tools such as Chrome, Safari, Bitwarden, and 1Password
- One-entry-per-line lists
- Name and password blocks separated by blank lines

The import screen previews what it found before anything is saved. If an
imported row has the same title and username as an existing entry, it is skipped
as a duplicate.

## Exporting A Backup

Use **Settings -> Export all to Markdown** to save a readable backup of your
vault.

The exported file is plaintext. It contains real usernames, passwords, keywords,
and notes. Store it somewhere safe, move it to secure backup storage, or delete
it when you no longer need it.

The Markdown export is intentionally readable and can be imported again later.

## Sync

Sync is optional. The vault works locally even when sync is off or unavailable.

When sync is available, add a sync email in **Settings**. The email identifies
your sync account. Your master password is still the secret that unlocks the
vault, and the server stores only the encrypted vault blob.

To restore on another device:

1. Open the app on the new device.
2. Enter the same sync email.
3. Type the same master password.
4. Choose **Restore from sync**.

All synced devices must use the same master password. If another device created
a vault with a different master password, the app will keep your local copy and
refuse to pull that remote vault.

## Privacy And Security

- Your vault contents are encrypted with AES-256-GCM.
- Your master password is stretched with PBKDF2-SHA256 before use.
- Titles, usernames, passwords, keywords, and notes are all inside the encrypted
  vault.
- The master password is not stored.
- The web version saves the encrypted vault in the browser's local storage.
- The Mac app saves the encrypted vault in its app data folder.

Because the web version stores its local vault in browser storage, clearing site
data can remove the local copy. Keep sync enabled or export a backup if you need
recovery on a new browser or device.

## Settings

Settings lets you change:

- Auto-lock delay
- Clipboard clear delay
- Sync email
- Markdown export

The vault also locks shortly after the app or browser tab is hidden.

## Keyboard Shortcuts

- **Up / Down**: move through entries
- **Enter**: copy the selected password
- **Command/Ctrl + Enter**: copy the selected username
- **Command/Ctrl + E**: edit the selected entry
- **Command/Ctrl + N**: add a new entry
- **Command/Ctrl + I**: import passwords
- **Command/Ctrl + L**: lock the vault

## Important Note

This is a learning build and has not had the same hardening, audit, or recovery
work as a mature commercial password manager. Do not keep your only copy of
high-stakes credentials here until you are comfortable with that risk.
