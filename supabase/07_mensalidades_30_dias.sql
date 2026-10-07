-- VORTEX: primeira mensalidade 30 dias após o cadastro; renovação a cada 30 dias.
-- Preserva mensalidades e movimentações já registradas.
-- Reutiliza gerar-mensalidades-vortex; mantém o job de verificação offline.
begin;

create table if not exists public.vortex_ciclos_mensalidade (
  cliente_id uuid primary key references public.clientes(id) on delete cascade,
  proximo_vencimento date not null,
  atualizado_em timestamptz not null default now()
);
alter table public.vortex_ciclos_mensalidade enable row level security;
revoke all on public.vortex_ciclos_mensalidade from public, anon, authenticated;

-- Inicializa o cursor uma única vez, sem inventar débitos históricos.
with bases as (
  select c.id,
    coalesce(
      (select max(m.vencimento) + 30 from public.mensalidades m where m.cliente_id = c.id),
      (c.criado_em at time zone 'America/Sao_Paulo')::date + 30
    ) as base,
    (now() at time zone 'America/Sao_Paulo')::date as hoje
  from public.clientes c
  where lower(coalesce(c.tipo_usuario, 'cliente')) <> 'admin'
)
insert into public.vortex_ciclos_mensalidade (cliente_id, proximo_vencimento)
select id, case when base < hoje then base + ((hoje - base + 29) / 30) * 30 else base end
from bases
on conflict (cliente_id) do nothing;

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
    v_vencimento := (new.criado_em at time zone 'America/Sao_Paulo')::date + 30;
    insert into public.vortex_ciclos_mensalidade (cliente_id, proximo_vencimento)
    values (new.id, v_vencimento)
    on conflict (cliente_id) do nothing;
  elsif not old.ativo or lower(coalesce(old.tipo_usuario, 'cliente')) = 'admin' then
    -- Preserva cobranças já registradas e não gera períodos ausentes da pausa.
    select coalesce(max(m.vencimento) + 30,
      (new.criado_em at time zone 'America/Sao_Paulo')::date + 30)
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

drop trigger if exists trg_vortex_inicializar_ciclo_mensalidade on public.clientes;
create trigger trg_vortex_inicializar_ciclo_mensalidade
after insert or update of ativo, tipo_usuario on public.clientes
for each row execute function public.vortex_inicializar_ciclo_mensalidade();

create or replace function public.vortex_gerar_mensalidades_cliente(p_cliente_id uuid)
returns integer language plpgsql security definer set search_path = ''
as $function$
declare
  v_cliente record;
  v_vencimento date;
  v_hoje date := (now() at time zone 'America/Sao_Paulo')::date;
  v_quantidade integer := 0;
begin
  -- NO KEY UPDATE serializa o saldo sem bloquear os FKs de novos pagamentos.
  select c.id, c.criado_em into v_cliente
  from public.clientes c
  where c.id = p_cliente_id and c.ativo
    and lower(coalesce(c.tipo_usuario, 'cliente')) <> 'admin'
  for no key update;
  if not found then return 0; end if;

  insert into public.vortex_ciclos_mensalidade (cliente_id, proximo_vencimento)
  select p_cliente_id, coalesce(
    (select max(m.vencimento) + 30 from public.mensalidades m where m.cliente_id = p_cliente_id),
    (v_cliente.criado_em at time zone 'America/Sao_Paulo')::date + 30
  ) on conflict (cliente_id) do nothing;

  select proximo_vencimento into v_vencimento
  from public.vortex_ciclos_mensalidade
  where cliente_id = p_cliente_id for update;

  while v_vencimento <= v_hoje loop
    insert into public.mensalidades (cliente_id, valor, vencimento, status)
    values (p_cliente_id, 50.00, v_vencimento, 'pendente')
    on conflict (cliente_id, vencimento) do nothing;
    if found then v_quantidade := v_quantidade + 1; end if;
    v_vencimento := v_vencimento + 30;
  end loop;

  -- Registra também a próxima cobrança, para o cliente conhecer o vencimento.
  insert into public.mensalidades (cliente_id, valor, vencimento, status)
  values (p_cliente_id, 50.00, v_vencimento, 'pendente')
  on conflict (cliente_id, vencimento) do nothing;
  if found then v_quantidade := v_quantidade + 1; end if;

  update public.vortex_ciclos_mensalidade
  set proximo_vencimento = v_vencimento, atualizado_em = now()
  where cliente_id = p_cliente_id;
  return v_quantidade;
end;
$function$;

create or replace function public.saldo_disponivel_cliente_interno(p_cliente_id uuid)
returns numeric language sql stable security definer set search_path = ''
as $function$
  select greatest(
    coalesce((select sum(p.valor_cliente) from public.pagamentos p
      where p.cliente_id = p_cliente_id and upper(p.status) = 'PAID'), 0)
    - coalesce((select sum(ms.valor) from public.movimentacoes_saldo ms
      where ms.cliente_id = p_cliente_id and ms.tipo = 'mensalidade'), 0)
    - coalesce((select sum(r.valor) from public.repasses_clientes r
      where r.cliente_id = p_cliente_id and lower(r.status) = 'concluido'), 0),
    0
  );
$function$;

create or replace function public.cobrar_mensalidades_cliente(p_cliente_id uuid)
returns void language plpgsql security definer set search_path = ''
as $function$
declare
  v_mensalidade record;
  v_saldo numeric;
  v_falta numeric;
  v_desconto numeric;
  v_hoje date := (now() at time zone 'America/Sao_Paulo')::date;
begin
  perform 1 from public.clientes c
  where c.id = p_cliente_id and c.ativo
    and lower(coalesce(c.tipo_usuario, 'cliente')) <> 'admin'
  for no key update;
  if not found then return; end if;

  perform public.vortex_gerar_mensalidades_cliente(p_cliente_id);
  -- O saldo é calculado DEPOIS do bloqueio compartilhado com os repasses.
  v_saldo := public.saldo_disponivel_cliente_interno(p_cliente_id);

  for v_mensalidade in
    select id, valor, valor_descontado
    from public.mensalidades
    where cliente_id = p_cliente_id and lower(status) = 'pendente'
      and vencimento <= v_hoje
    order by vencimento, criado_em, id
    for update
  loop
    v_falta := greatest(round(v_mensalidade.valor - v_mensalidade.valor_descontado, 2), 0);
    if v_falta = 0 then
      update public.mensalidades set status = 'pago', pago_em = coalesce(pago_em, now())
      where id = v_mensalidade.id;
      continue;
    end if;
    exit when v_saldo <= 0;
    v_desconto := least(v_saldo, v_falta);

    insert into public.movimentacoes_saldo (cliente_id, mensalidade_id, tipo, valor, descricao)
    values (p_cliente_id, v_mensalidade.id, 'mensalidade', v_desconto,
      'Desconto automático da mensalidade VORTEX');
    update public.mensalidades
    set valor_descontado = valor_descontado + v_desconto,
        status = case when valor_descontado + v_desconto >= valor then 'pago' else 'pendente' end,
        pago_em = case when valor_descontado + v_desconto >= valor then coalesce(pago_em, now()) else pago_em end
    where id = v_mensalidade.id;
    v_saldo := v_saldo - v_desconto;
  end loop;
end;
$function$;

create or replace function public.saldo_disponivel_cliente(p_cliente_id uuid)
returns numeric language plpgsql stable security definer set search_path = ''
as $function$
begin
  if auth.uid() is null then raise exception 'Usuário não autenticado'; end if;
  if not coalesce(public.usuario_eh_admin(), false) and not exists (
    select 1 from public.clientes where id = p_cliente_id and user_id = auth.uid()
  ) then raise exception 'Acesso não autorizado'; end if;
  return public.saldo_disponivel_cliente_interno(p_cliente_id);
end;
$function$;

create or replace function public.registrar_repasse_cliente(
  p_cliente_id uuid, p_valor numeric, p_descricao text default 'Repasse ao cliente'
)
returns uuid language plpgsql security definer set search_path = ''
as $function$
declare
  v_saldo numeric;
  v_valor numeric;
  v_repasse_id uuid;
begin
  if auth.uid() is null then raise exception 'Usuário não autenticado'; end if;
  if not coalesce(public.usuario_eh_admin(), false) then
    raise exception 'Apenas a Central VORTEX pode registrar repasses';
  end if;
  if p_valor is null or p_valor::text in ('NaN', 'Infinity', '-Infinity') then
    raise exception 'Informe um valor de repasse válido';
  end if;
  v_valor := round(p_valor, 2);
  if v_valor <= 0 then raise exception 'Valor do repasse deve ser maior que zero'; end if;

  perform 1 from public.clientes c
  where c.id = p_cliente_id and c.ativo
    and lower(coalesce(c.tipo_usuario, 'cliente')) <> 'admin'
  for no key update;
  if not found then raise exception 'Cliente inválido ou inativo'; end if;

  -- Mensalidades já vencidas são quitadas antes de disponibilizar um repasse.
  perform public.cobrar_mensalidades_cliente(p_cliente_id);
  v_saldo := public.saldo_disponivel_cliente_interno(p_cliente_id);
  if v_valor > v_saldo then
    raise exception 'Saldo insuficiente. Disponível: R$ %', v_saldo;
  end if;
  insert into public.repasses_clientes (cliente_id, valor, status, descricao)
  values (p_cliente_id, v_valor, 'concluido', p_descricao)
  returning id into v_repasse_id;
  return v_repasse_id;
end;
$function$;

create or replace function public.processar_mensalidades_vortex_30_dias()
returns integer language plpgsql security definer set search_path = ''
as $function$
declare
  v_cliente record;
  v_quantidade integer := 0;
begin
  for v_cliente in select id from public.clientes
    where ativo and lower(coalesce(tipo_usuario, 'cliente')) <> 'admin' order by id
  loop
    v_quantidade := v_quantidade + public.vortex_gerar_mensalidades_cliente(v_cliente.id);
    perform public.cobrar_mensalidades_cliente(v_cliente.id);
  end loop;
  return v_quantidade;
end;
$function$;

-- Compatibilidade: jobs antigos passam a usar a regra nova, sem duplicar cobranças.
-- O argumento antigo não permite criar cobranças com datas arbitrárias.
create or replace function public.gerar_mensalidades_do_mes(p_mes date default current_date)
returns integer language plpgsql security definer set search_path = ''
as $function$
begin
  return public.processar_mensalidades_vortex_30_dias();
end;
$function$;

-- Funções de escrita internas: somente backend confiável e proprietário do banco.
revoke execute on function public.vortex_inicializar_ciclo_mensalidade() from public, anon, authenticated;
revoke execute on function public.vortex_gerar_mensalidades_cliente(uuid) from public, anon, authenticated;
revoke execute on function public.cobrar_mensalidades_cliente(uuid) from public, anon, authenticated;
revoke execute on function public.gerar_mensalidades_do_mes(date) from public, anon, authenticated;
revoke execute on function public.processar_mensalidades_vortex_30_dias() from public, anon, authenticated;
revoke execute on function public.saldo_disponivel_cliente_interno(uuid) from public, anon, authenticated;
grant execute on function public.cobrar_mensalidades_cliente(uuid) to service_role;
grant execute on function public.gerar_mensalidades_do_mes(date) to service_role;
grant execute on function public.processar_mensalidades_vortex_30_dias() to service_role;

revoke execute on function public.saldo_disponivel_cliente(uuid) from public, anon;
revoke execute on function public.registrar_repasse_cliente(uuid, numeric, text) from public, anon;
grant execute on function public.saldo_disponivel_cliente(uuid) to authenticated;
grant execute on function public.registrar_repasse_cliente(uuid, numeric, text) to authenticated;

-- Atualiza o mesmo job de mensalidades, sem criar um segundo agendamento.
-- Os vencimentos e descontos usam explicitamente a data de São Paulo.
select cron.schedule(
  'gerar-mensalidades-vortex', '15 * * * *',
  'select public.processar_mensalidades_vortex_30_dias();'
);

notify pgrst, 'reload schema';
commit;
