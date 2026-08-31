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
