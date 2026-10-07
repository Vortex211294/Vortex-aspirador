const {test, before, after, afterEach} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
let PGlite;
try { ({PGlite} = require(process.env.VORTEX_PGLITE_MODULE || '@electric-sql/pglite')); }
catch {
  test('mensalidades em PostgreSQL embarcado', {skip:'Instale @electric-sql/pglite ou informe VORTEX_PGLITE_MODULE'}, () => {});
}

if (PGlite) {
  let db;
  const migration = fs.readFileSync(path.join(__dirname,'../supabase/07_mensalidades_30_dias.sql'),'utf8');
  const id = n => `00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
  const row = async (q,p=[]) => (await db.query(q,p)).rows[0];
  const scalar = async (q,p=[]) => Object.values(await row(q,p))[0];
  async function cliente(n,dias=0,{ativo=true,admin=false}={}) {
    await db.query(`insert into clientes(id,user_id,nome,ativo,tipo_usuario,criado_em)
      values ($1,$2,$3,$4,$5,now()-$6::integer*interval '1 day')`,[id(n),id(n+1000),`Cliente ${n}`,ativo,admin?'admin':'cliente',dias]);
  }
  async function pago(n,valor) {
    return row(`insert into pagamentos(cliente_id,valor_bruto,status)
      values ($1,$2,'PAID') returning *`,[id(n),valor]);
  }
  async function identificar(n,role='authenticated') {
    await db.exec('reset role');
    await db.query("select set_config('vortex.test_uid',$1,false)",[n===null?'':id(n+1000)]);
    await db.exec(`set role ${role}`);
  }
  async function restaurar() {
    await db.exec('reset role');
    await db.exec("select set_config('vortex.test_uid','',false)");
  }
  before(async()=>{
    db = new PGlite();
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create schema cron;
      create function auth.uid() returns uuid language sql stable as $$
        select nullif(current_setting('vortex.test_uid',true),'')::uuid $$;
      create table clientes(id uuid primary key default gen_random_uuid(),user_id uuid unique,
        nome text not null, mensalidade numeric not null default 50,ativo boolean not null default true,
        criado_em timestamptz not null default now(),tipo_usuario text default 'cliente');
      create table mensalidades(id uuid primary key default gen_random_uuid(),
        cliente_id uuid references clientes on delete cascade,valor numeric not null default 50,
        vencimento date not null,status text not null default 'pendente',pago_em timestamptz,
        criado_em timestamptz not null default now(),valor_descontado numeric not null default 0,
        unique(cliente_id,vencimento));
      create table pagamentos(id uuid primary key default gen_random_uuid(),
        cliente_id uuid references clientes,valor_bruto numeric not null,comissao_percentual numeric,
        comissao_vortex numeric,valor_cliente numeric,status text,pago_em timestamptz);
      create table movimentacoes_saldo(id uuid primary key default gen_random_uuid(),
        cliente_id uuid not null references clientes on delete cascade,
        mensalidade_id uuid references mensalidades on delete set null,tipo text not null,
        valor numeric not null,descricao text,criado_em timestamptz not null default now());
      create table repasses_clientes(id uuid primary key default gen_random_uuid(),
        cliente_id uuid not null references clientes on delete restrict,
        valor numeric not null check(valor>0),status text not null default 'concluido',
        descricao text,criado_em timestamptz not null default now());
      create table cron.job(jobid bigserial primary key,jobname text unique,schedule text,command text,active boolean default true);
      insert into cron.job(jobname,schedule,command) values
        ('vortex-verificar-offline','* * * * *','select offline_fixture();'),
        ('gerar-mensalidades-vortex','5 0 1 * *','select public.gerar_mensalidades_do_mes();');
      create function cron.schedule(text,text,text) returns bigint language plpgsql as $$
      declare v_id bigint; begin
        insert into cron.job(jobname,schedule,command) values($1,$2,$3)
        on conflict(jobname) do update set schedule=excluded.schedule,command=excluded.command
        returning jobid into v_id; return v_id; end; $$;
      create function usuario_eh_admin() returns boolean language sql stable security definer
      set search_path = 'public' as $$
        select exists(select 1 from public.clientes where user_id=auth.uid()
          and lower(coalesce(tipo_usuario,'cliente'))='admin') $$;
      create function cobrar_mensalidades_cliente(uuid) returns void language plpgsql security definer as $$
        begin return; end; $$;
      create function gerar_mensalidades_do_mes(date default current_date) returns integer
        language plpgsql security definer as $$ begin return 0; end; $$;
      create function processar_financeiro_pagamento() returns trigger language plpgsql
      security definer as $$ begin
        if upper(coalesce(new.status,''))='PAID' and (tg_op='INSERT' or old.status is distinct from new.status) then
          new.comissao_percentual:=2.99;
          new.comissao_vortex:=round(new.valor_bruto*2.99/100,2);
          new.valor_cliente:=round(new.valor_bruto-new.comissao_vortex,2);
          if new.pago_em is null then new.pago_em:=now(); end if;
        end if; return new; end; $$;
      create function verificar_mensalidade_apos_pagamento() returns trigger language plpgsql
      security definer as $$ begin
        if upper(coalesce(new.status,''))='PAID' and (tg_op='INSERT' or old.status is distinct from new.status) then
          perform cobrar_mensalidades_cliente(new.cliente_id);
        end if; return new; end; $$;
      create trigger trg_calcular_valores_pagamento before insert or update on pagamentos
        for each row execute function processar_financeiro_pagamento();
      create trigger trg_verificar_mensalidade_apos_pagamento after insert or update of status on pagamentos
        for each row execute function verificar_mensalidade_apos_pagamento();
      grant usage on schema public,auth to anon,authenticated,service_role;
    `);
    await cliente(1,100);
    await pago(1,100);
    await db.query(`insert into mensalidades(id,cliente_id,valor,vencimento,status,valor_descontado,pago_em)
      values ($1,$2,50,(now() at time zone 'America/Sao_Paulo')::date-10,'pago',50,now())`,[id(9001),id(1)]);
    await db.query(`insert into movimentacoes_saldo(cliente_id,mensalidade_id,tipo,valor)
      values ($1,$2,'mensalidade',50)`,[id(1),id(9001)]);
    await cliente(2,200);
    const preparation = fs.readFileSync(path.join(__dirname,'../supabase/06b_permissoes_agendamento.sql'),'utf8');
    await db.exec(preparation);
    assert.equal(await scalar("select has_function_privilege('anon','public.cobrar_mensalidades_cliente(uuid)','execute')"),false);
    assert.equal(await scalar("select has_function_privilege('service_role','public.cobrar_mensalidades_cliente(uuid)','execute')"),true);
    await db.exec(migration);
    await cliente(99,0,{admin:true});
  });
  after(async()=>{if(db)await db.close();});
  afterEach(async()=>{if(db)await restaurar();});

  test('SQL executa, preserva histórico e inicia legado sem retroativos ausentes',async()=>{
    assert.equal(Number(await scalar('select valor_descontado from mensalidades where id=$1',[id(9001)])),50);
    assert.equal(Number(await scalar('select saldo_disponivel_cliente_interno($1)',[id(1)])),47.01);
    assert.equal(await scalar(`select proximo_vencimento =
      (select vencimento+30 from mensalidades where id=$1) from vortex_ciclos_mensalidade where cliente_id=$2`,[id(9001),id(1)]),true);
    assert.equal(await scalar(`select proximo_vencimento >= (now() at time zone 'America/Sao_Paulo')::date
      from vortex_ciclos_mensalidade where cliente_id=$1`,[id(2)]),true);
    assert.equal(Number(await scalar('select count(*) from mensalidades where cliente_id=$1',[id(2)])),0);
  });

  test('primeira cobrança vence após 30 dias e não desconta antes do vencimento',async()=>{
    await cliente(3);
    const p=await pago(3,100);
    assert.equal(Number(p.valor_cliente),97.01);
    assert.equal(await scalar(`select vencimento=(now() at time zone 'America/Sao_Paulo')::date+30
      from mensalidades where cliente_id=$1`,[id(3)]),true);
    assert.equal(Number(await scalar('select saldo_disponivel_cliente_interno($1)',[id(3)])),97.01);
    assert.equal(Number(await scalar('select count(*) from movimentacoes_saldo where cliente_id=$1',[id(3)])),0);
  });

  test('desconto parcial usa saldo líquido e completa R$50 nos pagamentos seguintes',async()=>{
    await cliente(4,30);
    await pago(4,20);
    let m=await row("select * from mensalidades where cliente_id=$1 and vencimento <= (now() at time zone 'America/Sao_Paulo')::date",[id(4)]);
    assert.equal(Number(m.valor_descontado),19.40);assert.equal(m.status,'pendente');
    assert.equal(Number(await scalar('select saldo_disponivel_cliente_interno($1)',[id(4)])),0);
    await pago(4,40);
    m=await row('select * from mensalidades where id=$1',[m.id]);
    assert.equal(Number(m.valor_descontado),50);assert.equal(m.status,'pago');assert.ok(m.pago_em);
    assert.equal(Number(await scalar('select saldo_disponivel_cliente_interno($1)',[id(4)])),8.20);
    assert.equal(Number(await scalar('select sum(valor) from movimentacoes_saldo where cliente_id=$1',[id(4)])),50);
    assert.equal(await scalar(`select max(vencimento)-min(vencimento) from mensalidades where cliente_id=$1`,[id(4)]),30);
  });

  test('rotina repetida e aplicação repetida não duplicam mensalidades, descontos ou job',async()=>{
    const beforeMov=await scalar('select count(*) from movimentacoes_saldo');
    await db.exec('select processar_mensalidades_vortex_30_dias()');
    const firstMens=await scalar('select count(*) from mensalidades');
    const firstMov=await scalar('select count(*) from movimentacoes_saldo');
    assert.equal(firstMov,beforeMov);
    await db.exec('select processar_mensalidades_vortex_30_dias()');
    await db.exec(migration);
    await db.exec('select processar_mensalidades_vortex_30_dias()');
    assert.equal(await scalar('select count(*) from mensalidades'),firstMens);
    assert.equal(await scalar('select count(*) from movimentacoes_saldo'),firstMov);
    assert.equal(Number(await scalar('select count(*) from cron.job')),2);
    const billing=await row("select * from cron.job where jobname='gerar-mensalidades-vortex'");
    assert.equal(Number(billing.jobid),2);
    assert.equal(billing.schedule,'15 * * * *');
    assert.equal(billing.command,'select public.processar_mensalidades_vortex_30_dias();');
    assert.equal(billing.active,true);
    const offline=await row("select * from cron.job where jobname='vortex-verificar-offline'");
    assert.equal(Number(offline.jobid),1);
    assert.equal(offline.schedule,'* * * * *');
    assert.equal(offline.command,'select offline_fixture();');
    assert.equal(offline.active,true);
  });

  test('administrador e cliente inativo não recebem cobranças novas nem desconto',async()=>{
    await cliente(5,70,{ativo:false});
    await pago(5,100);
    await db.exec('select processar_mensalidades_vortex_30_dias()');
    for(const n of [5,99])assert.equal(Number(await scalar('select count(*) from mensalidades where cliente_id=$1',[id(n)])),0);
    assert.equal(Number(await scalar('select saldo_disponivel_cliente_interno($1)',[id(5)])),97.01);
  });

  test('valida permissões reais: anônimo não cobra; cliente não repassa nem lê saldo alheio',async()=>{
    await identificar(null,'anon');
    await assert.rejects(db.query('select cobrar_mensalidades_cliente($1)',[id(3)]),/permission denied/);
    await assert.rejects(db.query('select gerar_mensalidades_do_mes()'),/permission denied/);
    await assert.rejects(db.query('select * from vortex_ciclos_mensalidade'),/permission denied/);
    await identificar(3);
    assert.equal(Number(await scalar('select saldo_disponivel_cliente($1)',[id(3)])),97.01);
    await assert.rejects(db.query('select saldo_disponivel_cliente($1)',[id(4)]),/Acesso não autorizado/);
    await assert.rejects(db.query('select registrar_repasse_cliente($1,1)',[id(3)]),/Apenas a Central/);
    await assert.rejects(db.query('select processar_mensalidades_vortex_30_dias()'),/permission denied/);
    await identificar(null,'service_role');
    await db.exec('select processar_mensalidades_vortex_30_dias()');
    await restaurar();
  });

  test('repasse por admin não permite usar o mesmo saldo duas vezes nem valores não finitos',async()=>{
    await identificar(99);
    await db.query('select registrar_repasse_cliente($1,80)',[id(3)]);
    assert.equal(Number(await scalar('select saldo_disponivel_cliente($1)',[id(3)])),17.01);
    await assert.rejects(db.query('select registrar_repasse_cliente($1,80)',[id(3)]),/Saldo insuficiente/);
    for (const val of ['NaN','Infinity','-Infinity','0.001','-1'])
      await assert.rejects(db.query('select registrar_repasse_cliente($1,$2::numeric)',[id(3),val]),/válido|maior que zero/);
    await restaurar();
    assert.equal(Number(await scalar('select count(*) from repasses_clientes where cliente_id=$1',[id(3)])),1);
  });

  test('mensalidade vencida tem prioridade no repasse; saldo insuficiente reverte toda a operação',async()=>{
    await cliente(6);
    await pago(6,100);
    await db.query(`insert into mensalidades(cliente_id,valor,vencimento,status)
      values ($1,50,(now() at time zone 'America/Sao_Paulo')::date,'pendente')`,[id(6)]);
    await identificar(99);
    await assert.rejects(db.query('select registrar_repasse_cliente($1,80)',[id(6)]),/Saldo insuficiente/);
    await restaurar();
    assert.equal(Number(await scalar('select count(*) from movimentacoes_saldo where cliente_id=$1',[id(6)])),0);
    await identificar(99);
    await db.query('select registrar_repasse_cliente($1,40)',[id(6)]);
    assert.equal(Number(await scalar('select saldo_disponivel_cliente($1)',[id(6)])),7.01);
    await restaurar();
    assert.equal(Number(await scalar('select sum(valor) from movimentacoes_saldo where cliente_id=$1',[id(6)])),50);
    assert.equal(Number(await scalar('select sum(valor) from repasses_clientes where cliente_id=$1',[id(6)])),40);
  });

  test('reativação não preenche períodos ausentes da pausa e mantém as cobranças registradas',async()=>{
    const existing=await scalar('select count(*) from mensalidades where cliente_id=$1',[id(3)]);
    await db.query('update clientes set ativo=false where id=$1',[id(3)]);
    await db.query("update vortex_ciclos_mensalidade set proximo_vencimento=(now() at time zone 'America/Sao_Paulo')::date-120 where cliente_id=$1",[id(3)]);
    await db.query('update clientes set ativo=true where id=$1',[id(3)]);
    assert.equal(await scalar("select proximo_vencimento >= (now() at time zone 'America/Sao_Paulo')::date from vortex_ciclos_mensalidade where cliente_id=$1",[id(3)]),true);
    assert.equal(await scalar('select count(*) from mensalidades where cliente_id=$1',[id(3)]),existing);
    assert.equal(Number(await scalar("select count(*) from mensalidades where cliente_id=$1 and vencimento < (now() at time zone 'America/Sao_Paulo')::date",[id(3)])),0);
  });

  test('retomada da rotina gera intervalos exatos de 30 dias e paga os mais antigos primeiro',async()=>{
    await cliente(7,95);
    await pago(7,120);
    const m=(await db.query('select *,vencimento-lag(vencimento) over(order by vencimento) as intervalo from mensalidades where cliente_id=$1 order by vencimento',[id(7)])).rows;
    assert.equal(m.length,4);
    assert.equal(m[0].status,'pago');assert.equal(m[1].status,'pago');
    assert.equal(m[2].status,'pendente');assert.equal(Number(m[2].valor_descontado),16.41);
    assert.equal(Number(m[3].valor_descontado),0);
    for(const x of m.slice(1))assert.equal(x.intervalo,30);
    assert.equal(Number(await scalar('select sum(valor) from movimentacoes_saldo where cliente_id=$1',[id(7)])),116.41);
    await db.query('select cobrar_mensalidades_cliente($1)',[id(7)]);
    assert.equal(Number(await scalar('select count(*) from movimentacoes_saldo where cliente_id=$1',[id(7)])),3);
  });

  const firstReceipts = fs.readFileSync(path.join(__dirname,'../supabase/08_primeiros_recebimentos_mensalidade.sql'),'utf8');
  test('primeiros recebimentos: migração antecipa somente cliente sem cobrança anterior',async()=>{
    await cliente(200);
    await db.query('select vortex_gerar_mensalidades_cliente($1)',[id(200)]);
    const fee=await row('select * from mensalidades where cliente_id=$1',[id(200)]);
    const paidBefore=await row('select * from mensalidades where id=$1',[id(9001)]);
    const oldBalance=await scalar('select saldo_disponivel_cliente_interno($1)',[id(1)]);
    await db.exec(firstReceipts);
    const changed=await row('select * from mensalidades where id=$1',[fee.id]);
    assert.equal(changed.status,'pendente');
    assert.equal(await scalar("select vencimento=(now() at time zone 'America/Sao_Paulo')::date from mensalidades where id=$1",[fee.id]),true);
    assert.deepEqual(await row('select * from mensalidades where id=$1',[id(9001)]),paidBefore);
    assert.equal(await scalar('select saldo_disponivel_cliente_interno($1)',[id(1)]),oldBalance);
    assert.equal(await scalar('select max(vencimento)-min(vencimento) from mensalidades where cliente_id=$1',[id(200)]),30);
  });

  test('novo cadastro destina primeiros R$50 líquidos à mensalidade imediatamente',async()=>{
    await cliente(201);
    assert.equal(await scalar("select min(vencimento)=(now() at time zone 'America/Sao_Paulo')::date from mensalidades where cliente_id=$1",[id(201)]),true);
    await pago(201,20);
    assert.equal(Number(await scalar('select sum(valor) from movimentacoes_saldo where cliente_id=$1',[id(201)])),19.40);
    assert.equal(Number(await scalar('select saldo_disponivel_cliente_interno($1)',[id(201)])),0);
    await pago(201,40);
    assert.equal(Number(await scalar('select sum(valor) from movimentacoes_saldo where cliente_id=$1',[id(201)])),50);
    assert.equal(Number(await scalar('select saldo_disponivel_cliente_interno($1)',[id(201)])),8.20);
    const fees=(await db.query('select * from mensalidades where cliente_id=$1 order by vencimento',[id(201)])).rows;
    assert.equal(fees.length,2);assert.equal(fees[0].status,'pago');
    assert.equal(Number(fees[1].valor_descontado),0);assert.equal(fees[1].status,'pendente');
    await identificar(99);
    await db.query('select registrar_repasse_cliente($1,8.2)',[id(201)]);
    assert.equal(Number(await scalar('select saldo_disponivel_cliente($1)',[id(201)])),0);
  });

  test('primeiros recebimentos não cobra admins/inativos e conserva permissões do gatilho',async()=>{
    await cliente(202,0,{ativo:false});await cliente(203,0,{admin:true});
    for(const n of [202,203]) {
      await pago(n,100);
      assert.equal(Number(await scalar('select count(*) from mensalidades where cliente_id=$1',[id(n)])),0);
      assert.equal(Number(await scalar('select saldo_disponivel_cliente_interno($1)',[id(n)])),97.01);
    }
    assert.equal(await scalar("select has_function_privilege('anon','public.vortex_inicializar_ciclo_mensalidade()','execute')"),false);
    assert.equal(await scalar("select has_function_privilege('authenticated','public.cobrar_mensalidades_cliente(uuid)','execute')"),false);
  });

  test('reaplicar primeiros recebimentos não duplica taxa, desconto ou agendamento',async()=>{
    const beforeFees=await scalar('select count(*) from mensalidades');
    const beforeMov=await scalar('select sum(valor) from movimentacoes_saldo');
    await db.exec(firstReceipts);
    await db.exec('select processar_mensalidades_vortex_30_dias()');
    assert.equal(await scalar('select count(*) from mensalidades'),beforeFees);
    assert.equal(await scalar('select sum(valor) from movimentacoes_saldo'),beforeMov);
    assert.equal(Number(await scalar('select count(*) from cron.job')),2);
    assert.equal(await scalar("select schedule from cron.job where jobname='gerar-mensalidades-vortex'"),'15 * * * *');
  });

}
