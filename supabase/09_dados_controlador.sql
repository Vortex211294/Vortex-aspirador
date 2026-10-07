-- Cadastro manual exclusivo da Central/ADM. Não comprova telemetria nem instala firmware no equipamento.
begin;
create table if not exists public.vortex_dados_controlador (
  equipamento_id uuid primary key references public.equipamentos(id) on delete cascade,
  modelo text not null default '', serial text not null default '',
  ssid text not null default '', ip text not null default '', mac text not null default '',
  firmware_versao text not null default '', firmware_url text not null default '',
  firmware_sha256 text not null default '', observacoes text not null default '',
  atualizado_em timestamptz not null default now()
);
alter table public.vortex_dados_controlador enable row level security;
revoke all on public.vortex_dados_controlador from public, anon, authenticated;
grant select on public.vortex_dados_controlador to authenticated;
grant all on public.vortex_dados_controlador to service_role;
create policy controlador_leitura_proprietario on public.vortex_dados_controlador
for select to authenticated using (
  public.usuario_eh_admin() or exists (
    select 1 from public.equipamentos e join public.clientes c on c.id=e.cliente_id
    where e.id=equipamento_id and c.user_id=auth.uid() and c.ativo
  )
);

create or replace function public.salvar_dados_controlador_vortex(p_equipamento_id uuid, p_dados jsonb)
returns jsonb language plpgsql security definer set search_path = ''
as $function$
declare
  v_cliente uuid;
  v_chave text;
  v_max integer;
  v_resultado jsonb;
begin
  if auth.uid() is null then raise exception 'Usuário não autenticado'; end if;
  if p_dados is null or jsonb_typeof(p_dados) <> 'object' then
    raise exception 'Dados do controlador inválidos';
  end if;
  select cliente_id into v_cliente from public.equipamentos where id=p_equipamento_id for no key update;
  if not found then raise exception 'Equipamento não encontrado'; end if;
  if not coalesce(public.usuario_eh_admin(),false) then
    raise exception 'Apenas a Central/ADM pode cadastrar ou alterar controladores';
  end if;
  foreach v_chave in array array['modelo','serial','ssid','ip','mac','firmware_versao','firmware_url','firmware_sha256','observacoes'] loop
    if p_dados ? v_chave and jsonb_typeof(p_dados->v_chave) <> 'string' then
      raise exception 'Informe texto no campo %',v_chave;
    end if;
    v_max := case when v_chave='observacoes' then 2000 when v_chave='firmware_url' then 1000 else 120 end;
    if length(coalesce(p_dados->>v_chave,''))>v_max then raise exception 'Campo % muito longo',v_chave; end if;
  end loop;
  if coalesce(p_dados->>'firmware_url','')<>'' and
     (p_dados->>'firmware_url' !~ '^https://[^[:space:]@]+$') then
    raise exception 'Use um endereço HTTPS para o firmware';
  end if;
  if coalesce(p_dados->>'firmware_sha256','')<>'' and p_dados->>'firmware_sha256' !~ '^[a-fA-F0-9]{64}$' then
    raise exception 'SHA-256 deve ter 64 caracteres hexadecimais';
  end if;
  if coalesce(p_dados->>'mac','')<>'' and p_dados->>'mac' !~* '^([a-f0-9]{2}:){5}[a-f0-9]{2}$' then
    raise exception 'MAC inválido. Exemplo: AA:BB:CC:DD:EE:FF';
  end if;
  if coalesce(p_dados->>'ip','')<>'' then
    perform (p_dados->>'ip')::inet;
  end if;
  insert into public.vortex_dados_controlador as d
    (equipamento_id,modelo,serial,ssid,ip,mac,firmware_versao,firmware_url,firmware_sha256,observacoes)
  values (p_equipamento_id,trim(coalesce(p_dados->>'modelo','')),trim(coalesce(p_dados->>'serial','')),
    trim(coalesce(p_dados->>'ssid','')),trim(coalesce(p_dados->>'ip','')),upper(trim(coalesce(p_dados->>'mac',''))),
    trim(coalesce(p_dados->>'firmware_versao','')),trim(coalesce(p_dados->>'firmware_url','')),
    lower(trim(coalesce(p_dados->>'firmware_sha256',''))),trim(coalesce(p_dados->>'observacoes','')))
  on conflict (equipamento_id) do update set modelo=excluded.modelo,serial=excluded.serial,
    ssid=excluded.ssid,ip=excluded.ip,mac=excluded.mac,firmware_versao=excluded.firmware_versao,
    firmware_url=excluded.firmware_url,firmware_sha256=excluded.firmware_sha256,
    observacoes=excluded.observacoes,atualizado_em=now()
  returning to_jsonb(d) into v_resultado;
  return v_resultado;
end;
$function$;
revoke execute on function public.salvar_dados_controlador_vortex(uuid,jsonb) from public,anon;
grant execute on function public.salvar_dados_controlador_vortex(uuid,jsonb) to authenticated;
notify pgrst,'reload schema';
commit;
