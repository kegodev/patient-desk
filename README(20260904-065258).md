# Patient Desk

[![Patient Desk Quality Checks](https://github.com/kegodev/patient-desk/actions/workflows/patient-desk-ci.yml/badge.svg)](https://github.com/kegodev/patient-desk/actions/workflows/patient-desk-ci.yml)

Patient Desk is a surgery patient-administration web app with Supabase Auth, multi-surgery Row Level Security, and browser-side encrypted patient content.

## Repository structure

```text
patient-desk/
├── .github/
│   └── workflows/
│       └── patient-desk-ci.yml
├── assets/
│   └── patient-desk-logo.jpg
├── css/
│   └── styles.css
├── docs/
│   └── SUPABASE_RECOVERY.md
├── js/
│   ├── app.js
│   ├── config.js
│   └── config.example.js
├── sql/
│   ├── 00_full_recovery.sql
│   ├── 01_base_schema.sql
│   ├── 02_e2ee_migration.sql
│   ├── 03_restore_encrypted_backup.sql
│   ├── 04_bootstrap_new_practice.sql
│   └── 05_verify_installation.sql
├── tests/
│   └── repository-smoke-check.mjs
├── .gitignore
├── index.html
├── README.md
└── SECURITY.md
```

## Run locally

Because the app uses browser APIs and external Supabase/jsPDF libraries, serve the repository over HTTP rather than opening `index.html` directly:

```bash
python -m http.server 8080
```

Then open `http://localhost:8080`.

## Quality checks

Patient Desk includes automated GitHub Actions checks for the static application and repository structure.

The workflow verifies:

- required application, recovery, security, and SQL files are present;
- JavaScript files have valid syntax;
- `index.html` references the expected CSS and JavaScript files;
- local files referenced by `index.html` exist;
- accidental placeholder files are not committed;
- `config.example.js` remains safe to share;
- browser configuration does not contain an obvious Supabase secret/service-role key.

Run the repository smoke checks locally with:

```bash
node tests/repository-smoke-check.mjs
```

## Switch to another Supabase project

1. Create the new Supabase project.
2. Run `sql/00_full_recovery.sql` in the new project's SQL Editor.
3. Create the administrator under **Authentication → Users**.
4. For a brand-new empty surgery, run `sql/04_bootstrap_new_practice.sql`.
5. For an existing encrypted surgery, use `sql/03_restore_encrypted_backup.sql` with the encrypted backup instead. It preserves the original practice UUID and record UUIDs, which are required by AES-GCM AAD.
6. Copy the new project URL and publishable key into `js/config.js`. Never use the service-role key in browser code.
7. Run `sql/05_verify_installation.sql`.
8. Deploy.

## Encryption recovery requirement

The database backup contains ciphertext and the wrapped data-encryption key, but not the surgery passphrase. To decrypt restored data, the surgery must still know the same encryption passphrase used before the account switch. KM Digital Labs or Supabase cannot derive it from the database.

## GitHub Pages

This repository is static and can be hosted directly with GitHub Pages. Set the Pages source to the repository's default branch/root. `index.html` references `css/styles.css`, `js/config.js`, and `js/app.js` with relative paths.

## Security

- Supabase browser client uses only the publishable key.
- RLS is the tenant security boundary.
- Patient payloads use client-side AES-256-GCM.
- The surgery DEK is wrapped using a PBKDF2-SHA256-derived key.
- File-number uniqueness uses a keyed blind index.
- Do not commit service-role keys, database passwords, or surgery encryption passphrases.

See `SECURITY.md` and `docs/SUPABASE_RECOVERY.md` for security and recovery guidance.

Designed by KM Digital Labs.

All copyrights are reserved. Do not edit or present this work as your own without permission from the owner.
