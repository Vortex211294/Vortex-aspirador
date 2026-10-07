begin;
create or replace function public.cadastrar_controlador_admin_vortex(
 p_cliente_id uuid,p_codigo text,p_nome text,p_preco_minuto numeric,
 p_tempo_minutos integer,p_valor_tempo numeric,p_dados jsonb default '{}'::jsonb
) returns jsonb language plpgsql security definer set search_path='' as $function$
declare v_id uuid; v_resultado jsonb;
begin
 if auth.uid() is null or not coalesce(public.usuario_eh_admin(),false) then
  raise exception 'Apenas a Central/ADM pode cadastrar controladores'; end if;
 if coalesce(trim(p_codigo),'') !~ '^[A-Za-z0-9_-]{3,60}$' or coalesce(length(trim(p_nome)),0) not between 1 and 120 then
  raise exception 'Informe código de 3 a 60 letras/números e nome do equipamento'; end if;
 perform 1 from public.clientes where id=p_cliente_id and ativo and lower(coalesce(tipo_usuario,'cliente'))<>'admin' for no key update;
 if not found then raise exception 'Selecione um cliente ativo'; end if;
 insert into public.equipamentos(cliente_id,codigo,nome,status,comando,tempo_acionamento_segundos)
 values(p_cliente_id,upper(trim(p_codigo)),trim(p_nome),'offline','aguardando',0) returning id into v_id;
 perform public.salvar_precos_equipamento_vortex(v_id,p_preco_minuto,p_tempo_minutos,p_valor_tempo);
 perform public.salvar_dados_controlador_vortex(v_id,p_dados);
 select jsonb_build_object('id',id,'cliente_id',cliente_id,'codigo',codigo,'nome',nome) into v_resultado from public.equipamentos where id=v_id;
 return v_resultado;
exception when unique_violation then raise exception 'Este código de equipamento já está cadastrado';
end;
$function$;
revoke execute on function public.cadastrar_controlador_admin_vortex(uuid,text,text,numeric,integer,numeric,jsonb) from public,anon;
grant execute on function public.cadastrar_controlador_admin_vortex(uuid,text,text,numeric,integer,numeric,jsonb) to authenticated;

create or replace function public.configuracoes_cliente_admin_vortex(
 p_cliente_id uuid,p_dados jsonb default null,p_recebimento jsonb default null
) returns jsonb language plpgsql security definer set search_path='' as $function$
declare v_cliente public.clientes; v_recebimento jsonb; v_chave text; v_mensalidade numeric;
begin
 if auth.uid() is null or not coalesce(public.usuario_eh_admin(),false) then
  raise exception 'Apenas a Central/ADM pode administrar clientes'; end if;
 select * into v_cliente from public.clientes where id=p_cliente_id for no key update;
 if not found then raise exception 'Cliente não encontrado'; end if;
 if p_dados is not null then
  if jsonb_typeof(p_dados)<>'object' then raise exception 'Cadastro inválido'; end if;
  foreach v_chave in array array['nome','telefone','cpf_cnpj','endereco'] loop
   if p_dados ? v_chave and (jsonb_typeof(p_dados->v_chave)<>'string' or length(p_dados->>v_chave)>case when v_chave='endereco' then 1000 else 200 end) then
    raise exception 'Campo % inválido',v_chave; end if;
  end loop;
  if p_dados ? 'nome' and length(trim(p_dados->>'nome'))<1 then raise exception 'Informe o nome'; end if;
  if p_dados ? 'ativo' and jsonb_typeof(p_dados->'ativo')<>'boolean' then raise exception 'Status inválido'; end if;
  if p_dados ? 'mensalidade' then
   if jsonb_typeof(p_dados->'mensalidade')<>'number' then raise exception 'Mensalidade inválida'; end if;
   v_mensalidade:=(p_dados->>'mensalidade')::numeric;
   if v_mensalidade<0.01 or v_mensalidade>10000 then raise exception 'Mensalidade deve ficar entre R$0,01 e R$10.000'; end if;
  end if;
  update public.clientes set
   nome=case when p_dados?'nome' then trim(p_dados->>'nome') else nome end,
   telefone=case when p_dados?'telefone' then trim(p_dados->>'telefone') else telefone end,
   cpf_cnpj=case when p_dados?'cpf_cnpj' then trim(p_dados->>'cpf_cnpj') else cpf_cnpj end,
   endereco=case when p_dados?'endereco' then trim(p_dados->>'endereco') else endereco end,
   ativo=case when p_dados?'ativo' then (p_dados->>'ativo')::boolean else ativo end,
   mensalidade=coalesce(round(v_mensalidade,2),mensalidade)
  where id=p_cliente_id returning * into v_cliente;
 end if;
 if p_recebimento is not null then
  if jsonb_typeof(p_recebimento)<>'object' then raise exception 'Recebimento inválido'; end if;
  foreach v_chave in array array['tipo_chave_pix','chave_pix','titular','banco','documento_titular','modo_cobranca'] loop
   if jsonb_typeof(p_recebimento->v_chave) is distinct from 'string' then raise exception 'Recebimento: campo % inválido',v_chave; end if;
  end loop;
  if p_recebimento->>'tipo_chave_pix' not in ('cpf_cnpj','telefone','email','aleatoria') or p_recebimento->>'modo_cobranca' not in ('fixo','minutos')
    or length(trim(p_recebimento->>'chave_pix')) not between 1 and 200 or length(trim(p_recebimento->>'titular')) not between 1 and 200
    or length(p_recebimento->>'banco')>200 or length(p_recebimento->>'documento_titular')>30 then raise exception 'Dados de recebimento inválidos'; end if;
  insert into public.vortex_dados_recebimento(cliente_id,tipo_chave_pix,chave_pix,titular,banco,documento_titular,modo_cobranca)
  values(p_cliente_id,p_recebimento->>'tipo_chave_pix',trim(p_recebimento->>'chave_pix'),trim(p_recebimento->>'titular'),trim(p_recebimento->>'banco'),trim(p_recebimento->>'documento_titular'),p_recebimento->>'modo_cobranca')
  on conflict(cliente_id) do update set tipo_chave_pix=excluded.tipo_chave_pix,chave_pix=excluded.chave_pix,titular=excluded.titular,banco=excluded.banco,documento_titular=excluded.documento_titular,modo_cobranca=excluded.modo_cobranca,atualizado_em=now();
 end if;
 select jsonb_build_object('tipo_chave_pix',tipo_chave_pix,'chave_pix',chave_pix,'titular',titular,'banco',banco,'documento_titular',documento_titular,'modo_cobranca',modo_cobranca)
 into v_recebimento from public.vortex_dados_recebimento where cliente_id=p_cliente_id;
 return jsonb_build_object('cliente',jsonb_build_object('id',v_cliente.id,'nome',v_cliente.nome,'telefone',v_cliente.telefone,'cpf_cnpj',v_cliente.cpf_cnpj,'endereco',v_cliente.endereco,'ativo',v_cliente.ativo,'mensalidade',v_cliente.mensalidade),'recebimento',v_recebimento);
end;
$function$;
revoke execute on function public.configuracoes_cliente_admin_vortex(uuid,jsonb,jsonb) from public,anon;
grant execute on function public.configuracoes_cliente_admin_vortex(uuid,jsonb,jsonb) to authenticated;
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
  select c.id, c.criado_em, c.mensalidade into v_cliente
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
    values (p_cliente_id, v_cliente.mensalidade, v_vencimento, 'pendente')
    on conflict (cliente_id, vencimento) do nothing;
    if found then v_quantidade := v_quantidade + 1; end if;
    v_vencimento := v_vencimento + 30;
  end loop;

  -- Registra também a próxima cobrança, para o cliente conhecer o vencimento.
  insert into public.mensalidades (cliente_id, valor, vencimento, status)
  values (p_cliente_id, v_cliente.mensalidade, v_vencimento, 'pendente')
  on conflict (cliente_id, vencimento) do nothing;
  if found then v_quantidade := v_quantidade + 1; end if;

  update public.vortex_ciclos_mensalidade
  set proximo_vencimento = v_vencimento, atualizado_em = now()
  where cliente_id = p_cliente_id;
  return v_quantidade;
end;
$function$;
revoke execute on function public.vortex_gerar_mensalidades_cliente(uuid) from public,anon,authenticated;
notify pgrst,'reload schema';
commit;
