-- Patient Desk — COMPLETE SUPABASE RECOVERY / FRESH INSTALL
-- Use this on a NEW Supabase project.
-- It creates the base multi-surgery schema, RLS policies, indexes, and the E2EE storage layer.
-- It does NOT create an Auth user/password. Create the administrator in Supabase Authentication first.

-- Admin Control — Supabase database setup
-- Run this ONCE in Supabase Dashboard > SQL Editor for project ajhacehrfdzskwraeczf.
-- The browser app uses only the publishable key. RLS is the security boundary.

create extension if not exists pgcrypto;

create table if not exists public.practices (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  owner_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.practice_members (
  practice_id uuid not null references public.practices(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'admin' check (role in ('owner', 'admin', 'receptionist')),
  created_at timestamptz not null default now(),
  primary key (practice_id, user_id)
);

create table if not exists public.patients (
  id uuid primary key default gen_random_uuid(),
  practice_id uuid not null references public.practices(id) on delete cascade,
  name text not null,
  id_number text not null,
  file_number text not null,
  medical_aid text not null,
  medical_aid_number text not null default '',
  plan text default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (practice_id, file_number)
);

create table if not exists public.beneficiaries (
  id uuid primary key default gen_random_uuid(),
  practice_id uuid not null references public.practices(id) on delete cascade,
  patient_id uuid not null references public.patients(id) on delete cascade,
  name text not null,
  relationship text not null default 'Other',
  file_number text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists public.consultations (
  id uuid primary key default gen_random_uuid(),
  practice_id uuid not null references public.practices(id) on delete cascade,
  patient_id uuid not null references public.patients(id) on delete cascade,
  beneficiary_id uuid references public.beneficiaries(id) on delete set null,
  person_type text not null check (person_type in ('client', 'beneficiary')),
  person_name text not null,
  visit_date date not null,
  visit_type text not null default 'General consultation',
  notes text default '',
  created_at timestamptz not null default now()
);

-- Schema upgrades for projects that ran an earlier Admin Control setup script.
alter table public.patients add column if not exists medical_aid_number text not null default '';
alter table public.beneficiaries add column if not exists file_number text not null default '';

create index if not exists patients_practice_idx on public.patients(practice_id);
create index if not exists patients_practice_name_idx on public.patients(practice_id, name);
create index if not exists patients_practice_file_idx on public.patients(practice_id, file_number);
create index if not exists patients_practice_medical_aid_number_idx on public.patients(practice_id, medical_aid_number);
create index if not exists beneficiaries_practice_file_number_idx on public.beneficiaries(practice_id, file_number);
create index if not exists beneficiaries_patient_idx on public.beneficiaries(patient_id);
create index if not exists consultations_patient_date_idx on public.consultations(patient_id, visit_date desc);
create index if not exists consultations_practice_date_idx on public.consultations(practice_id, visit_date desc);

alter table public.practices enable row level security;
alter table public.practice_members enable row level security;
alter table public.patients enable row level security;
alter table public.beneficiaries enable row level security;
alter table public.consultations enable row level security;

-- Remove policies with these names if this script is re-run.
drop policy if exists practices_select on public.practices;
drop policy if exists practices_insert on public.practices;
drop policy if exists practices_update on public.practices;
drop policy if exists practice_members_select on public.practice_members;
drop policy if exists practice_members_insert_self on public.practice_members;
drop policy if exists practice_members_delete_self on public.practice_members;
drop policy if exists patients_select on public.patients;
drop policy if exists patients_insert on public.patients;
drop policy if exists patients_update on public.patients;
drop policy if exists patients_delete on public.patients;
drop policy if exists beneficiaries_select on public.beneficiaries;
drop policy if exists beneficiaries_insert on public.beneficiaries;
drop policy if exists beneficiaries_update on public.beneficiaries;
drop policy if exists beneficiaries_delete on public.beneficiaries;
drop policy if exists consultations_select on public.consultations;
drop policy if exists consultations_insert on public.consultations;
drop policy if exists consultations_update on public.consultations;
drop policy if exists consultations_delete on public.consultations;

create policy practices_select
on public.practices for select to authenticated
using (
  owner_id = auth.uid()
  or exists (
    select 1 from public.practice_members pm
    where pm.practice_id = practices.id and pm.user_id = auth.uid()
  )
);

create policy practices_insert
on public.practices for insert to authenticated
with check (owner_id = auth.uid());

create policy practices_update
on public.practices for update to authenticated
using (owner_id = auth.uid())
with check (owner_id = auth.uid());

create policy practice_members_select
on public.practice_members for select to authenticated
using (user_id = auth.uid());

create policy practice_members_insert_self
on public.practice_members for insert to authenticated
with check (
  user_id = auth.uid()
  and exists (
    select 1 from public.practices p
    where p.id = practice_id and p.owner_id = auth.uid()
  )
);

create policy practice_members_delete_self
on public.practice_members for delete to authenticated
using (user_id = auth.uid());

create policy patients_select
on public.patients for select to authenticated
using (
  exists (
    select 1 from public.practice_members pm
    where pm.practice_id = patients.practice_id and pm.user_id = auth.uid()
  )
);

create policy patients_insert
on public.patients for insert to authenticated
with check (
  exists (
    select 1 from public.practice_members pm
    where pm.practice_id = patients.practice_id and pm.user_id = auth.uid()
  )
);

create policy patients_update
on public.patients for update to authenticated
using (
  exists (
    select 1 from public.practice_members pm
    where pm.practice_id = patients.practice_id and pm.user_id = auth.uid()
  )
)
with check (
  exists (
    select 1 from public.practice_members pm
    where pm.practice_id = patients.practice_id and pm.user_id = auth.uid()
  )
);

create policy patients_delete
on public.patients for delete to authenticated
using (
  exists (
    select 1 from public.practice_members pm
    where pm.practice_id = patients.practice_id and pm.user_id = auth.uid()
  )
);

create policy beneficiaries_select
on public.beneficiaries for select to authenticated
using (
  exists (
    select 1 from public.practice_members pm
    where pm.practice_id = beneficiaries.practice_id and pm.user_id = auth.uid()
  )
);

create policy beneficiaries_insert
on public.beneficiaries for insert to authenticated
with check (
  exists (
    select 1 from public.practice_members pm
    where pm.practice_id = beneficiaries.practice_id and pm.user_id = auth.uid()
  )
);

create policy beneficiaries_update
on public.beneficiaries for update to authenticated
using (
  exists (
    select 1 from public.practice_members pm
    where pm.practice_id = beneficiaries.practice_id and pm.user_id = auth.uid()
  )
)
with check (
  exists (
    select 1 from public.practice_members pm
    where pm.practice_id = beneficiaries.practice_id and pm.user_id = auth.uid()
  )
);

create policy beneficiaries_delete
on public.beneficiaries for delete to authenticated
using (
  exists (
    select 1 from public.practice_members pm
    where pm.practice_id = beneficiaries.practice_id and pm.user_id = auth.uid()
  )
);

create policy consultations_select
on public.consultations for select to authenticated
using (
  exists (
    select 1 from public.practice_members pm
    where pm.practice_id = consultations.practice_id and pm.user_id = auth.uid()
  )
);

create policy consultations_insert
on public.consultations for insert to authenticated
with check (
  exists (
    select 1 from public.practice_members pm
    where pm.practice_id = consultations.practice_id and pm.user_id = auth.uid()
  )
);

create policy consultations_update
on public.consultations for update to authenticated
using (
  exists (
    select 1 from public.practice_members pm
    where pm.practice_id = consultations.practice_id and pm.user_id = auth.uid()
  )
)
with check (
  exists (
    select 1 from public.practice_members pm
    where pm.practice_id = consultations.practice_id and pm.user_id = auth.uid()
  )
);

create policy consultations_delete
on public.consultations for delete to authenticated
using (
  exists (
    select 1 from public.practice_members pm
    where pm.practice_id = consultations.practice_id and pm.user_id = auth.uid()
  )
);

grant usage on schema public to authenticated;
grant select, insert, update, delete on public.practices to authenticated;
grant select, insert, update, delete on public.practice_members to authenticated;
grant select, insert, update, delete on public.patients to authenticated;
grant select, insert, update, delete on public.beneficiaries to authenticated;
grant select, insert, update, delete on public.consultations to authenticated;


-- =============================================================
-- E2EE layer
-- =============================================================

-- Patient Desk / Admin Control — client-side encrypted data migration
-- Run this ONCE in Supabase Dashboard > SQL Editor AFTER the existing Admin Control schema.
--
-- What this migration does:
--   1. Adds per-practice wrapped-key metadata.
--   2. Adds ciphertext envelopes to patient, beneficiary and consultation rows.
--   3. Replaces the plaintext file-number uniqueness rule with a keyed blind-index rule.
--   4. Allows consultation content/date columns to be scrubbed after browser-side encryption.
--   5. Adds RLS policies for the wrapped-key table.
--
-- IMPORTANT: This SQL does NOT encrypt existing plaintext by itself. The E2EE HTML performs
-- the one-time encryption in the browser after the surgery encryption passphrase is created.
-- The browser then clears the legacy plaintext columns. This is intentional: Supabase never
-- receives the passphrase or unwrapped data-encryption key.

begin;

create table if not exists public.practice_crypto (
  practice_id uuid primary key references public.practices(id) on delete cascade,
  crypto_version integer not null default 1,
  kdf text not null default 'PBKDF2-SHA256',
  kdf_iterations integer not null default 600000 check (kdf_iterations >= 100000),
  kdf_salt text not null,
  wrap_alg text not null default 'AES-256-GCM',
  wrap_iv text not null,
  wrapped_dek text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (crypto_version >= 1),
  check (length(kdf_salt) >= 16),
  check (length(wrap_iv) >= 12),
  check (length(wrapped_dek) >= 32)
);

alter table public.patients
  add column if not exists encrypted_payload jsonb,
  add column if not exists file_number_bidx text;

alter table public.beneficiaries
  add column if not exists encrypted_payload jsonb,
  add column if not exists file_number_bidx text;

alter table public.consultations
  add column if not exists encrypted_payload jsonb;

-- New encrypted consultation rows keep their sensitive values, including visit date,
-- inside encrypted_payload. These legacy columns are therefore nullable.
alter table public.consultations alter column person_name drop not null;
alter table public.consultations alter column visit_date drop not null;
alter table public.consultations alter column visit_type drop not null;

-- The old unique(practice_id, file_number) constraint cannot remain because encrypted
-- rows scrub plaintext file_number to ''. Remove only a unique constraint whose exact
-- ordered column set is practice_id + file_number.
do $$
declare
  r record;
begin
  for r in
    select c.conname
    from pg_constraint c
    where c.conrelid = 'public.patients'::regclass
      and c.contype = 'u'
      and (
        select array_agg(a.attname::text order by u.ord)
        from unnest(c.conkey) with ordinality as u(attnum, ord)
        join pg_attribute a
          on a.attrelid = c.conrelid
         and a.attnum = u.attnum
      ) = array['practice_id','file_number']::text[]
  loop
    execute format('alter table public.patients drop constraint %I', r.conname);
  end loop;
end
$$;

-- HMAC blind indexes are produced in the browser from the unlocked surgery key.
-- Supabase can enforce uniqueness without learning the plaintext file number.
create unique index if not exists patients_practice_file_number_bidx_key
  on public.patients(practice_id, file_number_bidx)
  where file_number_bidx is not null and file_number_bidx <> '';

create index if not exists beneficiaries_practice_file_number_bidx_idx
  on public.beneficiaries(practice_id, file_number_bidx)
  where file_number_bidx is not null and file_number_bidx <> '';

create index if not exists patients_practice_encrypted_idx
  on public.patients(practice_id, created_at desc)
  where encrypted_payload is not null;

create index if not exists consultations_practice_created_idx
  on public.consultations(practice_id, created_at desc)
  where encrypted_payload is not null;

alter table public.practice_crypto enable row level security;

drop policy if exists practice_crypto_select on public.practice_crypto;
drop policy if exists practice_crypto_insert on public.practice_crypto;
drop policy if exists practice_crypto_update on public.practice_crypto;

create policy practice_crypto_select
on public.practice_crypto for select to authenticated
using (
  exists (
    select 1
    from public.practice_members pm
    where pm.practice_id = practice_crypto.practice_id
      and pm.user_id = auth.uid()
  )
);

create policy practice_crypto_insert
on public.practice_crypto for insert to authenticated
with check (
  exists (
    select 1
    from public.practice_members pm
    where pm.practice_id = practice_crypto.practice_id
      and pm.user_id = auth.uid()
  )
);

create policy practice_crypto_update
on public.practice_crypto for update to authenticated
using (
  exists (
    select 1
    from public.practice_members pm
    where pm.practice_id = practice_crypto.practice_id
      and pm.user_id = auth.uid()
  )
)
with check (
  exists (
    select 1
    from public.practice_members pm
    where pm.practice_id = practice_crypto.practice_id
      and pm.user_id = auth.uid()
  )
);

grant select, insert, update on public.practice_crypto to authenticated;

comment on table public.practice_crypto is
  'Stores only KDF parameters and an AES-GCM wrapped practice data-encryption key. The passphrase and unwrapped DEK are never stored here.';
comment on column public.patients.encrypted_payload is
  'Client-side AES-256-GCM envelope containing patient name, ID number, file number, medical aid, medical aid number and plan.';
comment on column public.patients.file_number_bidx is
  'Keyed HMAC blind index of normalized file number for uniqueness without plaintext exposure.';
comment on column public.beneficiaries.encrypted_payload is
  'Client-side AES-256-GCM envelope containing beneficiary name, relationship and file number.';
comment on column public.consultations.encrypted_payload is
  'Client-side AES-256-GCM envelope containing visit date, person name, visit type and notes.';

commit;
