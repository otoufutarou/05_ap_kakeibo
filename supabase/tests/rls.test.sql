begin;

create extension if not exists pgtap with schema extensions;

insert into auth.users (id, aud, role, email, encrypted_password, email_confirmed_at)
values
  ('10000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'rls-a@example.invalid', '', now()),
  ('20000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'rls-b@example.invalid', '', now())
on conflict (id) do nothing;

select plan(11);
set local role authenticated;

select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', true);
insert into public.expenses (user_id, source_expense_id, name, amount, expense_date)
values ('10000000-0000-4000-8000-000000000001', 'rls-a', 'Aの記録', 100, '2026-10-01');
insert into public.user_settings (user_id, theme)
values ('10000000-0000-4000-8000-000000000001', 'blue');
select is((select count(*) from public.expenses), 1::bigint, 'A can read A expenses');
select is((select count(*) from public.user_settings), 1::bigint, 'A can read A settings');
select throws_ok(
  $$insert into public.expenses (user_id, source_expense_id, name, amount, expense_date)
    values ('20000000-0000-4000-8000-000000000002', 'forged', '不正な記録', 100, '2026-10-01')$$,
  '42501', null, 'A cannot insert for B'
);

select set_config('request.jwt.claim.sub', '20000000-0000-4000-8000-000000000002', true);
insert into public.expenses (user_id, source_expense_id, name, amount, expense_date)
values ('20000000-0000-4000-8000-000000000002', 'rls-b', 'Bの記録', 200, '2026-10-02');
insert into public.user_settings (user_id, theme)
values ('20000000-0000-4000-8000-000000000002', 'green');
select is((select count(*) from public.expenses), 1::bigint, 'B can read B expenses');
select is((select count(*) from public.user_settings), 1::bigint, 'B can read B settings');

select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', true);
select is((select count(*) from public.expenses where source_expense_id = 'rls-b'), 0::bigint, 'A cannot read B expenses');
select is((select count(*) from public.user_settings where user_id = '20000000-0000-4000-8000-000000000002'), 0::bigint, 'A cannot read B settings');
select is((with changed as (
  update public.expenses set name = '改ざん'
  where user_id = '20000000-0000-4000-8000-000000000002'
  returning 1
) select count(*) from changed), 0::bigint, 'A cannot update B expenses');
select throws_ok(
  $$update public.expenses set user_id = '20000000-0000-4000-8000-000000000002'
    where source_expense_id = 'rls-a'$$,
  '42501', null, 'A cannot transfer an expense to B'
);
select is((with removed as (
  delete from public.expenses
  where user_id = '20000000-0000-4000-8000-000000000002'
  returning 1
) select count(*) from removed), 0::bigint, 'A cannot delete B expenses');

reset role;
set local role anon;
select throws_ok('select * from public.expenses', '42501', null, 'anonymous users cannot read cloud expenses');

select * from finish();
rollback;
