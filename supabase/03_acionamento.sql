-- Baseado na função existente fornecida pelo administrador em 05/10/2026.
-- Aplicar no SQL Editor; criar/substituir a função não envia um comando.
begin;

create or replace function public.acionar_equipamento_remoto(
  p_equipamento_id uuid,
  p_tempo_segundos integer
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_cliente_id uuid;
  v_autorizado boolean := false;
begin
  if auth.uid() is null then
    raise exception 'Usuário não autenticado';
  end if;

  if p_tempo_segundos is null
     or p_tempo_segundos < 60
     or p_tempo_segundos > 7200 then
    raise exception 'Tempo de acionamento inválido';
  end if;

  select e.cliente_id into v_cliente_id
  from public.equipamentos e
  where e.id = p_equipamento_id
  for update;

  if not found then
    raise exception 'Equipamento não encontrado';
  end if;

  if public.usuario_eh_admin() then
    v_autorizado := true;
  end if;

  if exists (
    select 1 from public.clientes c
    where c.id = v_cliente_id
      and c.user_id = auth.uid()
      and coalesce(c.ativo, true) = true
  ) then
    v_autorizado := true;
  end if;

  if not v_autorizado then
    raise exception 'Você não tem permissão para acionar este equipamento';
  end if;

  update public.equipamentos
  set comando = 'ligar',
      tempo_acionamento_segundos = p_tempo_segundos,
      comando_criado_em = now()
  where id = p_equipamento_id;
end;
$function$;

revoke execute on function public.acionar_equipamento_remoto(uuid, integer)
  from public, anon;
grant execute on function public.acionar_equipamento_remoto(uuid, integer)
  to authenticated;

commit;
