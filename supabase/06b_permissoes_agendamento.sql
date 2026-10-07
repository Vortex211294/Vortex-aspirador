-- Fecha as funções de cobrança para visitantes e chamadas diretas de clientes.
-- Os gatilhos SECURITY DEFINER, o backend e os jobs do proprietário continuam funcionando.
begin;
revoke execute on function public.cobrar_mensalidades_cliente(uuid)
  from public, anon, authenticated;
revoke execute on function public.gerar_mensalidades_do_mes(date)
  from public, anon, authenticated;
grant execute on function public.cobrar_mensalidades_cliente(uuid) to service_role;
grant execute on function public.gerar_mensalidades_do_mes(date) to service_role;
commit;

select jsonb_build_object(
  'gatilhos_clientes', (
    select jsonb_agg(jsonb_build_object(
      'nome', t.tgname,
      'habilitado', t.tgenabled,
      'gatilho', pg_get_triggerdef(t.oid),
      'codigo', pg_get_functiondef(t.tgfoid)
    )) from pg_trigger t
    where t.tgrelid = 'public.clientes'::regclass and not t.tgisinternal
  ),
  'agendamentos', (
    select jsonb_agg(jsonb_build_object(
      'id', jobid, 'nome', jobname, 'horario', schedule, 'ativo', active,
      'executado_por', to_jsonb(j)->>'username',
      'chama_gerar_mensalidades', position('gerar_mensalidades_do_mes' in command) > 0,
      'chama_cobrar_mensalidades', position('cobrar_mensalidades_cliente' in command) > 0,
      'rotina_nova', position('processar_mensalidades_vortex_30_dias' in command) > 0,
      'menciona_mensalidade', lower(command) like '%mensalidade%'
    )) from cron.job j
  ),
  'anon_pode_cobrar', has_function_privilege(
    'anon', 'public.cobrar_mensalidades_cliente(uuid)', 'execute'
  ),
  'anon_pode_gerar', has_function_privilege(
    'anon', 'public.gerar_mensalidades_do_mes(date)', 'execute'
  )
) as diagnostico;
