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
