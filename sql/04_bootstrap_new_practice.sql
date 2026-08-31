-- Patient Desk — bootstrap a surgery workspace after switching Supabase projects
-- PREREQUISITES:
--   1) Run 00_full_recovery.sql.
--   2) Create the administrator under Supabase > Authentication > Users.
--   3) Replace the two values below and run this script.
--
-- For a BRAND-NEW surgery, leave v_practice_id := gen_random_uuid().
-- For RESTORING an encrypted backup, DO NOT use this script first; use
-- 03_restore_encrypted_backup.sql because encrypted AES-GCM AAD is tied to the
-- original practice UUID.

do $$
declare
  v_admin_email text := 'admin@example.com';
  v_practice_name text := 'Your Surgery Name';
  v_owner_id uuid;
  v_practice_id uuid := gen_random_uuid();
begin
  select id into v_owner_id
  from auth.users
  where lower(email) = lower(v_admin_email)
  limit 1;

  if v_owner_id is null then
    raise exception 'No Supabase Auth user found for %', v_admin_email;
  end if;

  insert into public.practices (id, name, owner_id)
  values (v_practice_id, v_practice_name, v_owner_id);

  insert into public.practice_members (practice_id, user_id, role)
  values (v_practice_id, v_owner_id, 'owner')
  on conflict (practice_id, user_id) do update set role = excluded.role;

  raise notice 'Created practice % with id %', v_practice_name, v_practice_id;
end $$;
