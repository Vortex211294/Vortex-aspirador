-- Somente leitura; retorna estrutura e código, sem dados dos clientes.
select jsonb_build_object(
  'colunas', (
    select jsonb_agg(to_jsonb(c))
    from (
      select table_name, column_name, data_type,
             is_nullable, column_default
      from information_schema.columns
      where table_schema = 'public'
        and table_name in (
          'clientes', 'mensalidades',
          'movimentacoes_saldo', 'repasses_clientes'
        )
      order by table_name, ordinal_position
    ) c
  ),
  'funcoes', (
    select jsonb_agg(jsonb_build_object(
      'nome', p.proname,
      'anon_executa', has_function_privilege('anon', p.oid, 'execute'),
      'autenticado_executa', has_function_privilege('authenticated', p.oid, 'execute'),
      'codigo', case when p.proname in (
        'saldo_disponivel_cliente_interno', 'registrar_repasse_cliente'
      ) then pg_get_functiondef(p.oid) else null end
    ))
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'saldo_disponivel_cliente_interno', 'registrar_repasse_cliente',
        'cobrar_mensalidades_cliente', 'gerar_mensalidades_do_mes'
      )
  ),
  'restricoes', (
    select jsonb_agg(jsonb_build_object(
      'tabela', c.relname, 'nome', k.conname,
      'definicao', pg_get_constraintdef(k.oid)
    ))
    from pg_constraint k
    join pg_class c on c.oid = k.conrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname in (
        'clientes', 'mensalidades',
        'movimentacoes_saldo', 'repasses_clientes'
      )
  ),
  'pg_cron_instalado', exists (
    select 1 from pg_extension where extname = 'pg_cron'
  )
) as diagnostico;
