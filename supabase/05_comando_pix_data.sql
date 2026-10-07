-- Função do gatilho existente trg_acionar_equipamento_pix.
-- Não reenvia pagamentos antigos; vale para novas transições para PAID.
begin;

create or replace function public.acionar_equipamento_pix()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if new.status = 'PAID'
     and old.status is distinct from 'PAID' then

    update public.equipamentos
    set comando = 'ligar',
        tempo_acionamento_segundos = new.minutos * 60,
        comando_criado_em = now()
    where id = new.equipamento_id;

    insert into public.sessoes (
      equipamento_id,
      pagamento_id,
      minutos_comprados,
      status
    )
    values (
      new.equipamento_id,
      new.id,
      new.minutos,
      'aguardando'
    )
    on conflict (pagamento_id) do nothing;
  end if;

  return new;
end;
$function$;

commit;
