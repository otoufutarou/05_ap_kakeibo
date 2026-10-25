begin;

create table if not exists public.expenses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  source_expense_id text not null,
  name text not null check (char_length(name) between 1 and 100),
  amount bigint not null check (amount > 0 and amount <= 9007199254740991),
  category text,
  expense_date date not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  constraint expenses_user_source_id_unique unique (user_id, source_expense_id)
);

create index if not exists expenses_user_date_idx
  on public.expenses (user_id, expense_date desc);

create table if not exists public.user_settings (
  user_id uuid primary key references auth.users (id) on delete cascade,
  theme text not null default 'purple'
    check (theme in ('purple', 'blue', 'green', 'yellow')),
  week_start smallint not null default 1 check (week_start between 0 and 6),
  updated_at timestamptz not null default now()
);

create or replace function public.p_kakeibo_set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := greatest(clock_timestamp(), old.updated_at + interval '1 microsecond');
  return new;
end;
$$;

drop trigger if exists p_kakeibo_expenses_set_updated_at on public.expenses;
create trigger p_kakeibo_expenses_set_updated_at
  before update on public.expenses
  for each row execute function public.p_kakeibo_set_updated_at();

drop trigger if exists p_kakeibo_user_settings_set_updated_at on public.user_settings;
create trigger p_kakeibo_user_settings_set_updated_at
  before update on public.user_settings
  for each row execute function public.p_kakeibo_set_updated_at();

revoke all on function public.p_kakeibo_set_updated_at() from public, anon, authenticated;

alter table public.expenses enable row level security;
alter table public.user_settings enable row level security;

revoke all on public.expenses, public.user_settings from public, anon, authenticated;
grant select on public.expenses to authenticated;
grant select, insert, update on public.user_settings to authenticated;

drop policy if exists "p_kakeibo_expenses_select_owner" on public.expenses;
create policy "p_kakeibo_expenses_select_owner"
  on public.expenses for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "p_kakeibo_expenses_insert_owner" on public.expenses;
drop policy if exists "p_kakeibo_expenses_update_owner" on public.expenses;
drop policy if exists "p_kakeibo_expenses_delete_owner" on public.expenses;

drop policy if exists "p_kakeibo_settings_select_owner" on public.user_settings;
create policy "p_kakeibo_settings_select_owner"
  on public.user_settings for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "p_kakeibo_settings_insert_owner" on public.user_settings;
create policy "p_kakeibo_settings_insert_owner"
  on public.user_settings for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "p_kakeibo_settings_update_owner" on public.user_settings;
create policy "p_kakeibo_settings_update_owner"
  on public.user_settings for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "p_kakeibo_settings_delete_owner" on public.user_settings;

create or replace function public.p_kakeibo_sync_expenses(p_expenses jsonb, p_expected jsonb)
returns setof public.expenses
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_row public.expenses%rowtype;
  desired jsonb;
  expected jsonb;
  source_id text;
  desired_date date;
  desired_created_at timestamptz;
  desired_category text;
  desired_metadata jsonb;
  caller_id uuid := auth.uid();
begin
  if caller_id is null
    or jsonb_typeof(p_expenses) is distinct from 'array'
    or jsonb_typeof(p_expected) is distinct from 'array' then
    raise exception 'invalid_sync_request' using errcode = '22023';
  end if;
  if jsonb_array_length(p_expenses) > 10000
    or jsonb_array_length(p_expected) > 10000 then
    raise exception 'invalid_sync_request' using errcode = '22023';
  end if;

  -- Serialize even new IDs, which cannot yet be protected with row locks.
  perform pg_advisory_xact_lock(hashtextextended(caller_id::text, 0));

  if (select count(*) from jsonb_array_elements(p_expenses)) <>
     (select count(distinct item->>'source_expense_id') from jsonb_array_elements(p_expenses) item)
     or (select count(*) from jsonb_array_elements(p_expected)) <>
     (select count(distinct item->>'source_expense_id') from jsonb_array_elements(p_expected) item) then
    raise exception 'duplicate_expense_id' using errcode = '22023';
  end if;

  for expected in select value from jsonb_array_elements(p_expected) order by value->>'source_expense_id'
  loop
    source_id := expected->>'source_expense_id';
    if jsonb_typeof(expected) is distinct from 'object'
      or jsonb_typeof(expected->'source_expense_id') is distinct from 'string'
      or source_id = ''
      or jsonb_typeof(expected->'updated_at') is distinct from 'string'
      or not isfinite((expected->>'updated_at')::timestamptz) then
      raise exception 'invalid_expense_id' using errcode = '22023';
    end if;
    -- Omission from a snapshot is not authorization to delete a record.
    if not exists (
      select 1 from jsonb_array_elements(p_expenses) item
      where item->>'source_expense_id' = source_id
    ) then
      continue;
    end if;
    select * into current_row
      from public.expenses
      where user_id = caller_id and source_expense_id = source_id
      for update;
    if found and current_row.updated_at <> (expected->>'updated_at')::timestamptz then
      if exists (
        select 1 from jsonb_array_elements(p_expenses) item
        where item->>'source_expense_id' = source_id
          and item->>'name' = current_row.name
          and (item->>'amount')::bigint = current_row.amount
          and (item->>'expense_date')::date = current_row.expense_date
          and nullif(item->>'category', '') is not distinct from current_row.category
          and coalesce(item->'metadata', '{}'::jsonb) = current_row.metadata
      ) then
        continue;
      end if;
      raise exception 'sync_conflict' using errcode = '40001';
    end if;
    if not found and exists (
      select 1 from jsonb_array_elements(p_expenses) item
      where item->>'source_expense_id' = source_id
    ) then
      raise exception 'sync_conflict' using errcode = '40001';
    end if;
  end loop;

  for desired in select value from jsonb_array_elements(p_expenses) order by value->>'source_expense_id'
  loop
    source_id := desired->>'source_expense_id';
    if jsonb_typeof(desired) is distinct from 'object'
      or jsonb_typeof(desired->'source_expense_id') is distinct from 'string'
      or source_id = ''
      or jsonb_typeof(desired->'name') is distinct from 'string'
      or btrim(desired->>'name') = ''
      or char_length(desired->>'name') > 100
      or jsonb_typeof(desired->'amount') is distinct from 'number'
      or coalesce((desired->>'amount') !~ '^[1-9][0-9]*$', true)
      or (desired->>'amount')::numeric > 9007199254740991
      or jsonb_typeof(desired->'expense_date') is distinct from 'string'
      or coalesce((desired->>'expense_date') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$', true) then
      raise exception 'invalid_expense' using errcode = '22023';
    end if;
    desired_date := (desired->>'expense_date')::date;
    desired_created_at := coalesce(nullif(desired->>'created_at', '')::timestamptz, now());
    if not isfinite(desired_created_at) then
      raise exception 'invalid_expense' using errcode = '22023';
    end if;
    desired_category := nullif(desired->>'category', '');
    desired_metadata := coalesce(desired->'metadata', '{}'::jsonb);
    if jsonb_typeof(desired_metadata) <> 'object' then
      raise exception 'invalid_expense_metadata' using errcode = '22023';
    end if;

    select * into current_row
      from public.expenses
      where user_id = caller_id and source_expense_id = source_id
      for update;
    if found then
      if not exists (
        select 1 from jsonb_array_elements(p_expected) item
        where item->>'source_expense_id' = source_id
      ) and (
        current_row.name <> desired->>'name'
        or current_row.amount <> (desired->>'amount')::bigint
        or current_row.expense_date <> desired_date
        or current_row.category is distinct from desired_category
        or current_row.metadata <> desired_metadata
      ) then
        raise exception 'sync_conflict' using errcode = '40001';
      end if;
      if current_row.name = desired->>'name'
        and current_row.amount = (desired->>'amount')::bigint
        and current_row.expense_date = desired_date
        and current_row.category is not distinct from desired_category
        and current_row.metadata = desired_metadata then
        continue;
      end if;
      update public.expenses
        set name = desired->>'name',
            amount = (desired->>'amount')::bigint,
            category = desired_category,
            expense_date = desired_date,
            updated_at = now(),
            metadata = desired_metadata
        where id = current_row.id and user_id = caller_id;
    else
      insert into public.expenses
        (user_id, source_expense_id, name, amount, category, expense_date, created_at, metadata)
      values
        (caller_id, source_id, desired->>'name', (desired->>'amount')::bigint,
         desired_category, desired_date, desired_created_at, desired_metadata);
    end if;
  end loop;

  return query
    select * from public.expenses
    where user_id = caller_id
    order by expense_date desc, created_at desc;
end;
$$;

alter function public.p_kakeibo_sync_expenses(jsonb, jsonb) owner to postgres;
revoke all on function public.p_kakeibo_sync_expenses(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.p_kakeibo_sync_expenses(jsonb, jsonb) to authenticated;

commit;
