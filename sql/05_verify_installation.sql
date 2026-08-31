-- Patient Desk — post-install verification
select
  n.nspname as schema_name,
  c.relname as table_name,
  c.relrowsecurity as rls_enabled
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in ('practices','practice_members','patients','beneficiaries','consultations','practice_crypto')
order by c.relname;

select schemaname, tablename, policyname, cmd
from pg_policies
where schemaname = 'public'
  and tablename in ('practices','practice_members','patients','beneficiaries','consultations','practice_crypto')
order by tablename, policyname;

select table_name, column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public'
  and table_name in ('patients','beneficiaries','consultations','practice_crypto')
order by table_name, ordinal_position;
