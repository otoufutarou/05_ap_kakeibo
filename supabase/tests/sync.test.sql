begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(23);

insert into auth.users (id, aud, role, email, encrypted_password, email_confirmed_at)
values ('30000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated',
  'sync@example.invalid', '', now());

set local role authenticated;
select set_config('request.jwt.claim.sub', '30000000-0000-4000-8000-000000000003', true);

select throws_ok($$select public.p_kakeibo_sync_expenses(null, '[]')$$,
  '22023', 'invalid_sync_request', 'SQL NULL input is rejected');
select throws_ok($$select public.p_kakeibo_sync_expenses('[]', 'null')$$,
  '22023', 'invalid_sync_request', 'JSON null baseline is rejected');
select throws_ok($$select public.p_kakeibo_sync_expenses('{}', '[]')$$,
  '22023', 'invalid_sync_request', 'non-array input is rejected');
select throws_ok($$select public.p_kakeibo_sync_expenses(
  '[{"source_expense_id":"a"},{"source_expense_id":"a"}]', '[]')$$,
  '22023', 'duplicate_expense_id', 'duplicate IDs are rejected');
select throws_ok($$select public.p_kakeibo_sync_expenses(
  '[{"source_expense_id":"a","name":"A","expense_date":"2026-10-01"}]', '[]')$$,
  '22023', 'invalid_expense', 'missing amount is rejected');
select throws_ok($$select public.p_kakeibo_sync_expenses(
  '[{"source_expense_id":"a","name":"A","amount":1}]', '[]')$$,
  '22023', 'invalid_expense', 'missing date is rejected');

select lives_ok($$select public.p_kakeibo_sync_expenses(
  '[{"source_expense_id":"a","name":"A","amount":100,"expense_date":"2026-10-01",
     "created_at":"2026-10-01T01:02:03Z","category":"legacy","metadata":{"note":"preserved"}}]', '[]')$$,
  'initial import succeeds');
select set_config('test.baseline', (select jsonb_agg(jsonb_build_object(
  'source_expense_id', source_expense_id, 'updated_at', updated_at))::text from public.expenses), true);
select is((select metadata->>'note' from public.expenses where source_expense_id = 'a'),
  'preserved', 'legacy metadata survives import');
select is((select created_at from public.expenses where source_expense_id = 'a'),
  '2026-10-01T01:02:03Z'::timestamptz, 'creation time survives import');
select lives_ok($$select public.p_kakeibo_sync_expenses(
  '[{"source_expense_id":"a","name":"A","amount":100,"expense_date":"2026-10-01",
     "category":"legacy","metadata":{"note":"preserved"}}]', '[]')$$,
  'identical re-import is idempotent');
select is((select count(*) from public.expenses), 1::bigint, 're-import does not duplicate records');
select throws_ok($$select public.p_kakeibo_sync_expenses(
  '[{"source_expense_id":"a","name":"different","amount":100,"expense_date":"2026-10-01"}]', '[]')$$,
  '40001', 'sync_conflict', 'import cannot overwrite an existing different record');

select lives_ok($$select public.p_kakeibo_sync_expenses(
  '[{"source_expense_id":"a","name":"new","amount":200,"expense_date":"2026-10-01",
     "category":"legacy","metadata":{"note":"preserved"}}]', current_setting('test.baseline')::jsonb)$$,
  'matching version can update');
select ok((select updated_at > (current_setting('test.baseline')::jsonb->0->>'updated_at')::timestamptz
  from public.expenses where source_expense_id = 'a'), 'version advances even within one transaction');
select throws_ok($$select public.p_kakeibo_sync_expenses(
  '[{"source_expense_id":"a","name":"stale","amount":100,"expense_date":"2026-10-01"}]',
  current_setting('test.baseline')::jsonb)$$,
  '40001', 'sync_conflict', 'stale snapshot cannot overwrite a newer edit');
select lives_ok($$select public.p_kakeibo_sync_expenses('[]', current_setting('test.baseline')::jsonb)$$,
  'omitting a previously seen record does not delete it');
select is((select name from public.expenses where source_expense_id = 'a'),
  'new', 'omitted record is retained unchanged');
select throws_ok($$update public.expenses set name = 'bypass'$$,
  '42501', null, 'direct writes cannot bypass version checks');
select throws_ok($$delete from public.expenses$$,
  '42501', null, 'direct deletion is denied');

select set_config('request.jwt.claim.sub', '', true);
select throws_ok($$select public.p_kakeibo_sync_expenses('[]', '[]')$$,
  '22023', 'invalid_sync_request', 'authenticated role without a user ID is rejected');
reset role;
set local role anon;
select throws_ok($$select public.p_kakeibo_sync_expenses('[]', '[]')$$,
  '42501', null, 'anonymous RPC execution is denied');
reset role;
select ok(not has_function_privilege('anon', 'public.p_kakeibo_sync_expenses(jsonb,jsonb)', 'execute'),
  'anonymous role has no execute grant');
select ok(not has_table_privilege('authenticated', 'public.user_settings', 'delete'),
  'settings deletion is not granted');

select * from finish();
rollback;
