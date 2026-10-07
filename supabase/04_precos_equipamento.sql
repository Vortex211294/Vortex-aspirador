-- Salva os três parâmetros de preço/tempo juntos, para proprietário ou ADMIN.
-- Não envia comandos nem altera pagamentos já gerados.
begin;

create or replace function public.salvar_precos_equipamento_vortex(
  p_equipamento_id uuid,
  p_preco_minuto numeric,
  p_tempo_minutos integer,
  p_valor_tempo numeric
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_cliente_id uuid;
  v_resultado jsonb;
begin
  if auth.uid() is null then
    raise exception 'Usuário não autenticado';
  end if;

  if p_preco_minuto is null or p_valor_tempo is null
     or p_preco_minuto::text in ('NaN', 'Infinity', '-Infinity')
     or p_valor_tempo::text in ('NaN', 'Infinity', '-Infinity') then
    raise exception 'Informe um preço válido';
  end if;

  if round(p_preco_minuto, 2) < 0.01
     or round(p_preco_minuto, 2) > 10000
     or round(p_valor_tempo, 2) < 0.01
     or round(p_valor_tempo, 2) > 10000 then
    raise exception 'Informe um valor entre R$0,01 e R$10.000,00';
  end if;

  if p_tempo_minutos is null or p_tempo_minutos < 1 or p_tempo_minutos > 120 then
    raise exception 'Informe um tempo inteiro entre 1 e 120 minutos';
  end if;

  select e.cliente_id into v_cliente_id
  from public.equipamentos e
  where e.id = p_equipamento_id
  for update;

  if not found then
    raise exception 'Equipamento não encontrado';
  end if;

  if not coalesce(public.usuario_eh_admin(), false)
     and not exists (
       select 1 from public.clientes c
       where c.id = v_cliente_id
         and c.user_id = auth.uid()
         and coalesce(c.ativo, true) = true
     ) then
    raise exception 'Você não tem permissão para editar este equipamento';
  end if;

  update public.equipamentos e
  set preco_minuto = round(p_preco_minuto, 2),
      tempo_minutos = p_tempo_minutos,
      valor_tempo = round(p_valor_tempo, 2)
  where e.id = p_equipamento_id
  returning jsonb_build_object(
    'id', e.id,
    'preco_minuto', e.preco_minuto,
    'tempo_minutos', e.tempo_minutos,
    'valor_tempo', e.valor_tempo
  ) into v_resultado;

  return v_resultado;
end;
$function$;

revoke execute on function public.salvar_precos_equipamento_vortex(uuid, numeric, integer, numeric)
  from public, anon;
grant execute on function public.salvar_precos_equipamento_vortex(uuid, numeric, integer, numeric)
  to authenticated;

notify pgrst, 'reload schema';
commit;
