create table if not exists public.expenses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  source_expense_id text not null,
  name text not null check (char_length(name) between 1 and 100),
  amount bigint not null check (amount > 0),
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

alter table public.expenses enable row level security;
alter table public.user_settings enable row level security;

revoke all on public.expenses, public.user_settings from anon;
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
