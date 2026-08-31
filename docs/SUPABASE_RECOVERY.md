# Supabase Recovery Guide

## Fresh project, no old patient data

1. Create a Supabase project.
2. Run `sql/00_full_recovery.sql`.
3. Create the administrator in Authentication.
4. Edit and run `sql/04_bootstrap_new_practice.sql`.
5. Update `js/config.js`.
6. Log in and create a new surgery encryption passphrase.

## Switch Supabase account and keep encrypted patient data

Before losing access to the old project, download Patient Desk's **encrypted JSON backup** from Settings.

1. Create the new Supabase project.
2. Run `sql/00_full_recovery.sql`.
3. Recreate the administrator under Authentication. The Auth user UUID may change; this is allowed.
4. Open `sql/03_restore_encrypted_backup.sql`. Set `v_admin_email` to the new administrator and paste the complete encrypted JSON backup into the `$backup$ ... $backup$` section.
5. Run the restore script. It intentionally restores the **original practice UUID and original patient/beneficiary/consultation UUIDs**. Do not replace them. Patient Desk binds AES-GCM ciphertext to these UUIDs as authenticated additional data.
6. Update `js/config.js` with the new Supabase URL and browser publishable key.
7. Run `sql/05_verify_installation.sql`.
8. Log in and enter the **same surgery encryption passphrase** used before the move.

### What SQL cannot recover

The encryption passphrase is intentionally not stored in Supabase or in the backup. If it is lost, the encrypted patient payloads cannot be decrypted. The SQL scripts can rebuild the schema and restore encrypted rows, but they cannot reconstruct that passphrase.
