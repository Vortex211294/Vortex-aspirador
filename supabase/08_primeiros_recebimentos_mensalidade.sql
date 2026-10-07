-- Aplicar depois de 07_mensalidades_30_dias.sql.
-- Primeira mensalidade: primeiros R$50 líquidos desde o cadastro.
-- Mensalidades já descontadas permanecem quitadas; renovação a cada 30 dias.
begin;

create or replace function public.vortex_inicializar_ciclo_mensalidade()
returns trigger language plpgsql security definer set search_path = ''
as $function$
declare
  v_vencimento date;
  v_hoje date := (now() at time zone 'America/Sao_Paulo')::date;
begin
  if not new.ativo or lower(coalesce(new.tipo_usuario, 'cliente')) = 'admin' then
    return new;
  end if;

  if tg_op = 'INSERT' then
    -- Começa no cadastro, sem período gratuito inicial.
    v_vencimento := v_hoje;
    insert into public.vortex_ciclos_mensalidade (cliente_id, proximo_vencimento)
    values (new.id, v_vencimento)
    on conflict (cliente_id) do nothing;
    perform public.vortex_gerar_mensalidades_cliente(new.id);
  elsif not old.ativo or lower(coalesce(old.tipo_usuario, 'cliente')) = 'admin' then
    -- Preserva cobranças registradas; não inventa débitos da pausa.
    select coalesce(max(m.vencimento) + 30, v_hoje)
    into v_vencimento from public.mensalidades m where m.cliente_id = new.id;
    if v_vencimento < v_hoje then
      v_vencimento := v_vencimento + ((v_hoje - v_vencimento + 29) / 30) * 30;
    end if;
    insert into public.vortex_ciclos_mensalidade (cliente_id, proximo_vencimento)
    values (new.id, v_vencimento)
    on conflict (cliente_id) do update
      set proximo_vencimento = excluded.proximo_vencimento, atualizado_em = now();
  end if;
  return new;
end;
$function$;
revoke execute on function public.vortex_inicializar_ciclo_mensalidade()
  from public, anon, authenticated;

-- Clientes sem mensalidade atual/histórica e sem nenhum desconto registrado
-- passam a começar hoje. Não altera o ciclo que já foi pago ou parcialmente pago.
do $migration$
declare
  v_cliente record;
  v_primeira uuid;
  v_quantidade integer;
  v_hoje date := (now() at time zone 'America/Sao_Paulo')::date;
begin
  for v_cliente in
    select c.id from public.clientes c
    where c.ativo and lower(coalesce(c.tipo_usuario, 'cliente')) <> 'admin'
    order by c.id for no key update
  loop
    if exists (
      select 1 from public.mensalidades m where m.cliente_id = v_cliente.id
      and (m.vencimento <= v_hoje or m.valor_descontado > 0 or lower(m.status) = 'pago')
    ) or exists (
      select 1 from public.movimentacoes_saldo ms
      where ms.cliente_id = v_cliente.id and ms.tipo = 'mensalidade'
    ) then continue; end if;

    select count(*) into v_quantidade from public.mensalidades m
    where m.cliente_id = v_cliente.id and lower(m.status) = 'pendente';
    if v_quantidade > 1 then
      raise exception 'Mais de uma cobrança futura para o cliente %. Revisar antes de alterar o primeiro ciclo.', v_cliente.id;
    end if;
    select m.id into v_primeira from public.mensalidades m
    where m.cliente_id = v_cliente.id and lower(m.status) = 'pendente'
    for update;
    if found then
      update public.mensalidades set vencimento = v_hoje where id = v_primeira;
    else
      insert into public.mensalidades (cliente_id, valor, vencimento, status)
      values (v_cliente.id, 50.00, v_hoje, 'pendente')
      on conflict (cliente_id, vencimento) do nothing;
    end if;
    insert into public.vortex_ciclos_mensalidade (cliente_id, proximo_vencimento)
    values (v_cliente.id, v_hoje + 30)
    on conflict (cliente_id) do update
      set proximo_vencimento = excluded.proximo_vencimento, atualizado_em = now();
  end loop;
end;
$migration$;

-- Desconta do saldo líquido já disponível até completar cada mensalidade vencida.
-- Pagamentos seguintes continuam acionando a mesma rotina protegida.
select public.processar_mensalidades_vortex_30_dias();
notify pgrst, 'reload schema';
commit;
