-- Somente leitura: mostra estrutura e permissões, sem exibir dados pessoais ou chaves.
-- Compartilhe os resultados destas consultas para conferir a integração existente.
select tablename, rowsecurity from pg_tables where schemaname = 'public'
  and tablename in ('clientes','equipamentos','pagamentos','sessoes','mensalidades','repasses_clientes','movimentacoes_saldo','retiradas_vortex','vortex_dados_recebimento')
order by tablename;

select table_name,column_name,data_type from information_schema.columns
where table_schema = 'public'
and table_name in ('clientes','equipamentos','pagamentos','sessoes','mensalidades','repasses_clientes','movimentacoes_saldo','retiradas_vortex')
order by table_name,ordinal_position;

select p.proname as funcao,pg_get_function_identity_arguments(p.oid) as parametros,
  p.prosecdef as security_definer,
  has_function_privilege('anon',p.oid,'execute') as anon_pode_executar,
  has_function_privilege('authenticated',p.oid,'execute') as autenticado_pode_executar
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname in ('acionar_equipamento_remoto','salvar_configuracao_equipamento',
  'saldo_central_vortex','saldo_disponivel_cliente','registrar_repasse_cliente','gerar_mensalidades_do_mes',
  'obter_recebimento_vortex','salvar_recebimento_vortex') order by p.proname;

select tablename,policyname,roles,cmd,qual,with_check from pg_policies
where schemaname='public' and tablename in ('clientes','equipamentos','pagamentos','sessoes','mensalidades','repasses_clientes')
order by tablename,policyname;

-- Inspecione o agendamento sem imprimir comandos que podem conter segredos.
-- Rode somente se a extensão pg_cron estiver instalada:
-- select jobid,jobname,schedule,active from cron.job;

-- Revisão financeira após confirmar PIX e registro do comando.
-- Uma célula com os códigos existentes; não altera cobranças nem saldos.
select string_agg(
  pg_get_functiondef(t.tgfoid), E'\n\n' order by t.tgname
) as codigo
from pg_trigger t
where t.tgrelid = 'public.pagamentos'::regclass
  and not t.tgisinternal
  and t.tgname in (
    'trg_calcular_valores_pagamento',
    'trg_verificar_mensalidade_apos_pagamento'
  );

-- Desconto da mensalidade, geração de cobranças e saldo usado no desconto.
select string_agg(
  pg_get_functiondef(p.oid), E'\n\n' order by p.proname, p.oid
) as codigo
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'cobrar_mensalidades_cliente',
    'gerar_mensalidades_do_mes',
    'saldo_disponivel_cliente'
  );
