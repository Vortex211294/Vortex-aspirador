-- Execute uma vez no SQL Editor do projeto VORTEX.
-- Migração aditiva: não altera pagamentos, saldos, comissão, mensalidades ou acionamento.
-- Pré-requisito: public.clientes(id uuid, user_id uuid).
begin;

create table if not exists public.vortex_dados_recebimento (
  cliente_id uuid primary key references public.clientes(id),
  tipo_chave_pix text not null check (tipo_chave_pix in ('cpf_cnpj','telefone','email','aleatoria')),
  chave_pix text not null check (length(chave_pix) between 1 and 200),
  titular text not null check (length(titular) between 1 and 200),
  banco text not null default '' check (length(banco) <= 200),
  documento_titular text not null default '' check (length(documento_titular) <= 30),
  modo_cobranca text not null default 'fixo' check (modo_cobranca in ('fixo','minutos')),
  atualizado_em timestamptz not null default now()
);

alter table public.vortex_dados_recebimento enable row level security;
-- Dados financeiros só são acessíveis pelos RPCs abaixo, que determinam o titular no servidor.
revoke all on public.vortex_dados_recebimento from public, anon, authenticated;

create or replace function public.salvar_recebimento_vortex(
  p_tipo_chave_pix text, p_chave_pix text, p_titular text,
  p_banco text, p_documento_titular text, p_modo_cobranca text
) returns void language plpgsql security definer set search_path = '' as $$
declare v_cliente_id uuid;
begin
  if auth.uid() is null then raise exception 'Autenticação necessária' using errcode = '42501'; end if;
  select id into strict v_cliente_id from public.clientes where user_id = auth.uid();
  if p_tipo_chave_pix is null or p_tipo_chave_pix not in ('cpf_cnpj','telefone','email','aleatoria')
     or p_modo_cobranca is null or p_modo_cobranca not in ('fixo','minutos')
     or coalesce(length(trim(p_chave_pix)),0) not between 1 and 200
     or coalesce(length(trim(p_titular)),0) not between 1 and 200
     or length(coalesce(p_banco,'')) > 200 or length(coalesce(p_documento_titular,'')) > 30
  then raise exception 'Dados de recebimento inválidos' using errcode = '22023'; end if;
  insert into public.vortex_dados_recebimento
    (cliente_id,tipo_chave_pix,chave_pix,titular,banco,documento_titular,modo_cobranca)
  values (v_cliente_id,p_tipo_chave_pix,trim(p_chave_pix),trim(p_titular),trim(coalesce(p_banco,'')),trim(coalesce(p_documento_titular,'')),p_modo_cobranca)
  on conflict (cliente_id) do update set
    tipo_chave_pix = excluded.tipo_chave_pix, chave_pix = excluded.chave_pix,
    titular = excluded.titular, banco = excluded.banco, documento_titular = excluded.documento_titular,
    modo_cobranca = excluded.modo_cobranca, atualizado_em = now();
end;
$$;

create or replace function public.obter_recebimento_vortex()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_cliente_id uuid; v_dados jsonb;
begin
  if auth.uid() is null then raise exception 'Autenticação necessária' using errcode = '42501'; end if;
  select id into strict v_cliente_id from public.clientes where user_id = auth.uid();
  select jsonb_build_object('tipo_chave_pix',tipo_chave_pix,'chave_pix',chave_pix,'titular',titular,
    'banco',banco,'documento_titular',documento_titular,'modo_cobranca',modo_cobranca)
  into v_dados from public.vortex_dados_recebimento where cliente_id = v_cliente_id;
  return v_dados;
end;
$$;

revoke all on function public.salvar_recebimento_vortex(text,text,text,text,text,text) from public, anon;
revoke all on function public.obter_recebimento_vortex() from public, anon;
grant execute on function public.salvar_recebimento_vortex(text,text,text,text,text,text) to authenticated;
grant execute on function public.obter_recebimento_vortex() to authenticated;

commit;
