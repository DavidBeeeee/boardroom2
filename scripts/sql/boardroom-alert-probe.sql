-- WBR-373 boardroom_alert probe (Developer 80). One DO block, always rolled
-- back: it ends by raising PROBE_RESULT, so nothing it touches survives.
-- Calls boardroom_alert as a real admin and as a real non-admin under the
-- authenticated role with their JWT claims, and reads the grants back.
do $probe$
declare
  v_admin uuid;
  v_member uuid;
  v_rows integer;
  v_metrics text;
  v_member_refused boolean := false;
  v_member_error text := '';
begin
  select u.auth_id into v_admin from public.users u where coalesce(u.is_admin, false) and u.auth_id is not null limit 1;
  select u.auth_id into v_member from public.users u where not coalesce(u.is_admin, false) and u.auth_id is not null limit 1;
  if v_admin is null or v_member is null then
    raise exception 'PROBE_RESULT %', json_build_object('ok', false, 'reason', 'need one admin and one non-admin user');
  end if;

  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select count(*), string_agg(a.metric || '=' || a.events || '/' || a.total_calls || (case when a.breached then ' BREACHED' else '' end), ', ' order by a.metric)
    into v_rows, v_metrics
    from public.boardroom_alert(24) a;
  execute 'reset role';

  perform set_config('request.jwt.claims', json_build_object('sub', v_member, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  begin
    perform * from public.boardroom_alert(24);
  exception when insufficient_privilege then
    v_member_refused := true;
    v_member_error := sqlerrm;
  end;
  execute 'reset role';

  raise exception 'PROBE_RESULT %', json_build_object(
    'ok', v_rows = 5 and v_member_refused,
    'adminRows', v_rows,
    'adminMetrics', v_metrics,
    'memberRefused', v_member_refused,
    'memberError', v_member_error,
    'anonCanExecute', has_function_privilege('anon', 'public.boardroom_alert(integer)', 'execute'),
    'publicAcl', (select p.proacl::text from pg_proc p where p.oid = 'public.boardroom_alert(integer)'::regprocedure),
    'securityDefiner', (select p.prosecdef from pg_proc p where p.oid = 'public.boardroom_alert(integer)'::regprocedure),
    'searchPath', (select array_to_string(p.proconfig, ',') from pg_proc p where p.oid = 'public.boardroom_alert(integer)'::regprocedure)
  );
end
$probe$;
