Your **personal data** lives in a local database on the device. It is never
sent to a server. To carry it between devices or keep a backup, the app
supports export and import.

## What is in the backup

A backup file includes everything personal:

- Your playlist and the order of tracks in it.
- Listening progress for every track and which tracks you have completed.
- Notes and bookmarks.
- Downloaded-track records.
- Saved search filters.

A backup does **not** include the lecture catalog itself — that comes from
the content server. After importing on a new device the app will fetch the
catalog automatically.

## Export

1. Open **Settings → Data → Export user data**.
2. On a phone, the system share sheet opens — pick where to save (cloud
   drive, email, Files, etc.). On the web, the browser starts a download.
3. The file is a regular SQLite database.

You can export as often as you like — exporting does not change anything in
the app.

## Import

1. Open **Settings → Data → Import user data**.
2. Pick a previously exported `.db` file.
3. Confirm the replacement dialog. The app stops the player, replaces every
   user table with what is in the file, and reloads.

> **Heads-up.** Import **replaces** the existing data — playlist, notes,
> downloads and progress in the app right now will be overwritten. There is
> no undo. Export the current state first if you want to keep it.

## Clear cache vs. clear user data

In the **Danger zone** (visible only after unlocking the debug section) you
will find two destructive options that are easy to confuse:

- **Clear cache** removes all downloaded audio and transcripts. It does
  not touch your playlist, notes or listening progress.
- **Clear user data** wipes every personal table — same effect as a fresh
  install. The lecture catalog stays.

Always export before clearing user data.
