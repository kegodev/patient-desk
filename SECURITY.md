# Security Policy

Patient Desk handles sensitive administrative patient information. Production deployments should use HTTPS, enforce Supabase RLS, restrict administrator accounts, keep service-role credentials out of frontend code, and maintain encrypted backups.

Do not publish real patient backups, encryption passphrases, Supabase service-role keys, database passwords, or other private credentials in this repository.
