-- Patient Desk — restore an ENCRYPTED Patient Desk backup into a NEW Supabase project
--
-- WHY THE ORIGINAL PRACTICE UUID MUST BE PRESERVED
-- Patient Desk AES-256-GCM uses the practice UUID and each record UUID as authenticated
-- additional data (AAD). Changing those UUIDs makes the ciphertext fail authentication.
-- This restore therefore preserves the backup's practice UUID and all record UUIDs.
--
-- PREREQUISITES
-- 1. Run 00_full_recovery.sql in the NEW project.
-- 2. Create the replacement administrator under Supabase > Authentication > Users.
-- 3. Open your downloaded patient-desk-encrypted-backup-YYYY-MM-DD.json.
-- 4. Replace ADMIN_EMAIL below.
-- 5. Paste the ENTIRE JSON backup between $backup$ ... $backup$ below.
-- 6. Run this script once.
-- 7. Configure js/config.js for the new Supabase project, log in, and use the SAME
--    encryption passphrase that was used on the old project.
--
-- This script never needs the encryption passphrase and never decrypts patient data.

do $restore$
declare
  v_admin_email text := 'admin@example.com';
  v_backup jsonb := $backup$
{
  "PASTE": "YOUR COMPLETE patient-desk-e2ee-backup JSON HERE"
}
$backup$::jsonb;
  v_owner_id uuid;
  v_practice_id uuid;
  v_practice_name text;
begin
  if v_backup->>'format' is distinct from 'patient-desk-e2ee-backup' then
    raise exception 'Backup format is not patient-desk-e2ee-backup';
  end if;

  select id into v_owner_id
  from auth.users
  where lower(email) = lower(v_admin_email)
  limit 1;

  if v_owner_id is null then
    raise exception 'No Supabase Auth user found for %', v_admin_email;
  end if;

  v_practice_id := (v_backup #>> '{practice,id}')::uuid;
  v_practice_name := coalesce(v_backup #>> '{practice,name}', 'Patient Desk Surgery');

  -- Preserve the original practice UUID: required by AES-GCM AAD and wrapped DEK AAD.
  insert into public.practices (id, name, owner_id)
  values (v_practice_id, v_practice_name, v_owner_id)
  on conflict (id) do update
    set name = excluded.name,
        owner_id = excluded.owner_id;

  insert into public.practice_members (practice_id, user_id, role)
  values (v_practice_id, v_owner_id, 'owner')
  on conflict (practice_id, user_id) do update set role = excluded.role;

  insert into public.practice_crypto (
    practice_id, crypto_version, kdf, kdf_iterations, kdf_salt,
    wrap_alg, wrap_iv, wrapped_dek
  ) values (
    v_practice_id,
    coalesce((v_backup #>> '{crypto,crypto_version}')::integer, 1),
    coalesce(v_backup #>> '{crypto,kdf}', 'PBKDF2-SHA256'),
    coalesce((v_backup #>> '{crypto,kdf_iterations}')::integer, 600000),
    v_backup #>> '{crypto,kdf_salt}',
    coalesce(v_backup #>> '{crypto,wrap_alg}', 'AES-256-GCM'),
    v_backup #>> '{crypto,wrap_iv}',
    v_backup #>> '{crypto,wrapped_dek}'
  )
  on conflict (practice_id) do update set
    crypto_version = excluded.crypto_version,
    kdf = excluded.kdf,
    kdf_iterations = excluded.kdf_iterations,
    kdf_salt = excluded.kdf_salt,
    wrap_alg = excluded.wrap_alg,
    wrap_iv = excluded.wrap_iv,
    wrapped_dek = excluded.wrapped_dek,
    updated_at = now();

  insert into public.patients (
    id, practice_id, name, id_number, file_number, medical_aid, medical_aid_number,
    plan, encrypted_payload, file_number_bidx, created_at, updated_at
  )
  select
    (x->>'id')::uuid,
    v_practice_id,
    coalesce(x->>'name',''),
    coalesce(x->>'id_number',''),
    coalesce(x->>'file_number',''),
    coalesce(x->>'medical_aid',''),
    coalesce(x->>'medical_aid_number',''),
    coalesce(x->>'plan',''),
    x->'encrypted_payload',
    nullif(x->>'file_number_bidx',''),
    coalesce((x->>'created_at')::timestamptz, now()),
    coalesce((x->>'updated_at')::timestamptz, now())
  from jsonb_array_elements(coalesce(v_backup #> '{records,patients}', '[]'::jsonb)) x
  on conflict (id) do update set
    practice_id = excluded.practice_id,
    name = excluded.name,
    id_number = excluded.id_number,
    file_number = excluded.file_number,
    medical_aid = excluded.medical_aid,
    medical_aid_number = excluded.medical_aid_number,
    plan = excluded.plan,
    encrypted_payload = excluded.encrypted_payload,
    file_number_bidx = excluded.file_number_bidx,
    created_at = excluded.created_at,
    updated_at = excluded.updated_at;

  insert into public.beneficiaries (
    id, practice_id, patient_id, name, relationship, file_number,
    encrypted_payload, file_number_bidx, created_at
  )
  select
    (x->>'id')::uuid,
    v_practice_id,
    (x->>'patient_id')::uuid,
    coalesce(x->>'name',''),
    coalesce(x->>'relationship',''),
    coalesce(x->>'file_number',''),
    x->'encrypted_payload',
    nullif(x->>'file_number_bidx',''),
    coalesce((x->>'created_at')::timestamptz, now())
  from jsonb_array_elements(coalesce(v_backup #> '{records,beneficiaries}', '[]'::jsonb)) x
  on conflict (id) do update set
    practice_id = excluded.practice_id,
    patient_id = excluded.patient_id,
    name = excluded.name,
    relationship = excluded.relationship,
    file_number = excluded.file_number,
    encrypted_payload = excluded.encrypted_payload,
    file_number_bidx = excluded.file_number_bidx,
    created_at = excluded.created_at;

  insert into public.consultations (
    id, practice_id, patient_id, beneficiary_id, person_type, person_name,
    visit_date, visit_type, notes, encrypted_payload, created_at
  )
  select
    (x->>'id')::uuid,
    v_practice_id,
    (x->>'patient_id')::uuid,
    nullif(x->>'beneficiary_id','')::uuid,
    x->>'person_type',
    nullif(x->>'person_name',''),
    nullif(x->>'visit_date','')::date,
    nullif(x->>'visit_type',''),
    nullif(x->>'notes',''),
    x->'encrypted_payload',
    coalesce((x->>'created_at')::timestamptz, now())
  from jsonb_array_elements(coalesce(v_backup #> '{records,consultations}', '[]'::jsonb)) x
  on conflict (id) do update set
    practice_id = excluded.practice_id,
    patient_id = excluded.patient_id,
    beneficiary_id = excluded.beneficiary_id,
    person_type = excluded.person_type,
    person_name = excluded.person_name,
    visit_date = excluded.visit_date,
    visit_type = excluded.visit_type,
    notes = excluded.notes,
    encrypted_payload = excluded.encrypted_payload,
    created_at = excluded.created_at;

  raise notice 'Encrypted Patient Desk backup restored for practice % (%)', v_practice_name, v_practice_id;
end
$restore$;
