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

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists expenses_set_updated_at on public.expenses;
create trigger expenses_set_updated_at
  before update on public.expenses
  for each row execute function public.set_updated_at();

drop trigger if exists user_settings_set_updated_at on public.user_settings;
create trigger user_settings_set_updated_at
  before update on public.user_settings
  for each row execute function public.set_updated_at();

revoke all on function public.set_updated_at() from public, anon, authenticated;

alter table public.expenses enable row level security;
alter table public.user_settings enable row level security;

revoke all on public.expenses, public.user_settings from public, anon, authenticated;
grant select, insert, update, delete on public.expenses to authenticated;
grant select, insert, update, delete on public.user_settings to authenticated;

drop policy if exists "Users can read own expenses" on public.expenses;
create policy "Users can read own expenses"
  on public.expenses for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users can insert own expenses" on public.expenses;
create policy "Users can insert own expenses"
  on public.expenses for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can update own expenses" on public.expenses;
create policy "Users can update own expenses"
  on public.expenses for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can delete own expenses" on public.expenses;
create policy "Users can delete own expenses"
  on public.expenses for delete to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users can read own settings" on public.user_settings;
create policy "Users can read own settings"
  on public.user_settings for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users can insert own settings" on public.user_settings;
create policy "Users can insert own settings"
  on public.user_settings for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can update own settings" on public.user_settings;
create policy "Users can update own settings"
  on public.user_settings for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can delete own settings" on public.user_settings;
create policy "Users can delete own settings"
  on public.user_settings for delete to authenticated
  using ((select auth.uid()) = user_id);

create or replace function public.sync_expenses(p_expenses jsonb, p_expected jsonb)
returns setof public.expenses
language plpgsql
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
begin
  if auth.uid() is null
    or jsonb_typeof(p_expenses) <> 'array'
    or jsonb_typeof(p_expected) <> 'array'
    or jsonb_array_length(p_expenses) > 10000
    or jsonb_array_length(p_expected) > 10000 then
    raise exception 'invalid_sync_request' using errcode = '22023';
  end if;

  if (select count(*) from jsonb_array_elements(p_expenses)) <>
     (select count(distinct item->>'source_expense_id') from jsonb_array_elements(p_expenses) item)
     or (select count(*) from jsonb_array_elements(p_expected)) <>
     (select count(distinct item->>'source_expense_id') from jsonb_array_elements(p_expected) item) then
    raise exception 'duplicate_expense_id' using errcode = '22023';
  end if;

  for expected in select value from jsonb_array_elements(p_expected)
  loop
    source_id := expected->>'source_expense_id';
    if source_id is null or source_id = '' or expected->>'updated_at' is null then
      raise exception 'invalid_expense_id' using errcode = '22023';
    end if;
    select * into current_row
      from public.expenses
      where user_id = auth.uid() and source_expense_id = source_id
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

  for desired in select value from jsonb_array_elements(p_expenses)
  loop
    source_id := desired->>'source_expense_id';
    if source_id is null or source_id = ''
      or coalesce(desired->>'name', '') = ''
      or char_length(desired->>'name') > 100
      or (desired->>'amount') !~ '^[1-9][0-9]*$'
      or (desired->>'amount')::numeric > 9007199254740991
      or (desired->>'expense_date') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
      raise exception 'invalid_expense' using errcode = '22023';
    end if;
    desired_date := (desired->>'expense_date')::date;
    desired_created_at := coalesce(nullif(desired->>'created_at', '')::timestamptz, now());
    desired_category := nullif(desired->>'category', '');
    desired_metadata := coalesce(desired->'metadata', '{}'::jsonb);
    if jsonb_typeof(desired_metadata) <> 'object' then
      raise exception 'invalid_expense_metadata' using errcode = '22023';
    end if;

    select * into current_row
      from public.expenses
      where user_id = auth.uid() and source_expense_id = source_id
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
        where id = current_row.id;
    else
      insert into public.expenses
        (user_id, source_expense_id, name, amount, category, expense_date, created_at, metadata)
      values
        (auth.uid(), source_id, desired->>'name', (desired->>'amount')::bigint,
         desired_category, desired_date, desired_created_at, desired_metadata);
    end if;
  end loop;

  for expected in select value from jsonb_array_elements(p_expected)
  loop
    source_id := expected->>'source_expense_id';
    if not exists (
      select 1 from jsonb_array_elements(p_expenses) item
      where item->>'source_expense_id' = source_id
    ) then
      delete from public.expenses
        where user_id = auth.uid()
          and source_expense_id = source_id
          and updated_at = (expected->>'updated_at')::timestamptz;
    end if;
  end loop;

  return query
    select * from public.expenses
    where user_id = auth.uid()
    order by expense_date desc, created_at desc;
end;
$$;

revoke all on function public.sync_expenses(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.sync_expenses(jsonb, jsonb) to authenticated;
