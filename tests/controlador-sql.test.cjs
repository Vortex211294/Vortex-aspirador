const {test,before,after,afterEach}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
let PGlite;try {({PGlite}=require(process.env.VORTEX_PGLITE_MODULE || '@electric-sql/pglite'));}catch{}
if(!PGlite) test('cadastro controlador PostgreSQL',{skip:'Instale @electric-sql/pglite'},()=>{});
else {
 let db;const c='00000000-0000-0000-0000-000000000001',u='00000000-0000-0000-0000-000000000002',e='00000000-0000-0000-0000-000000000003';
 before(async()=>{db=new PGlite();await db.exec(`create role anon;create role authenticated;create role service_role;
 create schema auth;create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create table public.clientes(id uuid primary key,user_id uuid,ativo boolean,nome text default 'Cliente',telefone text,cpf_cnpj text,endereco text,mensalidade numeric default 50,tipo_usuario text default 'cliente',criado_em timestamptz default now());
 create table public.mensalidades(id uuid default gen_random_uuid(),cliente_id uuid,valor numeric,vencimento date,status text,unique(cliente_id,vencimento));
 create table public.vortex_ciclos_mensalidade(cliente_id uuid primary key,proximo_vencimento date,atualizado_em timestamptz default now());
 create table public.vortex_dados_recebimento(cliente_id uuid primary key,tipo_chave_pix text,chave_pix text,titular text,banco text,documento_titular text,modo_cobranca text,atualizado_em timestamptz default now());
 create table public.equipamentos(id uuid primary key default gen_random_uuid(),cliente_id uuid references public.clientes,codigo text unique,nome text,status text,comando text,tempo_acionamento_segundos integer,preco_minuto numeric,tempo_minutos integer,valor_tempo numeric);
 create function public.usuario_eh_admin() returns boolean language sql stable as $$select coalesce(current_setting('test.admin',true),'false')='true'$$;
 insert into public.clientes(id,user_id,ativo) values('${c}','${u}',true);insert into public.equipamentos(id,cliente_id) values('${e}','${c}');`);
 await db.exec(fs.readFileSync(path.join(__dirname,'../supabase/09_dados_controlador.sql'),'utf8'));
 await db.exec(fs.readFileSync(path.join(__dirname,'../supabase/04_precos_equipamento.sql'),'utf8'));
 await db.exec(fs.readFileSync(path.join(__dirname,'../supabase/10_administracao_clientes_controladores.sql'),'utf8'));
 await db.exec('begin;');});
 afterEach(async()=>{await db.exec('rollback;begin;');});after(async()=>{await db.exec('rollback;');await db.close();});
 const save=async(data)=> (await db.query('select public.salvar_dados_controlador_vortex($1,$2::jsonb) as dados',[e,JSON.stringify(data)])).rows[0].dados;
 test('controller admin persists fields, firmware does not issue motor commands',async()=>{
  await db.query("select set_config('request.jwt.claim.sub',$1,true)",[u]);await db.exec("select set_config('test.admin','true',true);");
  const r=await save({modelo:' ESP32 ',firmware_versao:'1.0',firmware_url:'https://example.com/fw.bin',ip:'192.168.1.2',mac:'aa:bb:cc:dd:ee:ff'});
  assert.equal(r.modelo,'ESP32');assert.equal(r.mac,'AA:BB:CC:DD:EE:FF');
  const again=await save({modelo:'ESP8266'});assert.equal(again.modelo,'ESP8266');
  assert.equal((await db.query('select count(*)::int as n from vortex_dados_controlador')).rows[0].n,1);
 });
 test('unauthenticated and owner client cannot save controller',async()=>{
  await assert.rejects(save({modelo:'bad'}),/não autenticado/);
  await db.exec('rollback;begin;');await db.query("select set_config('request.jwt.claim.sub',$1,true)",[u]);
  await assert.rejects(save({modelo:'bad'}),/Apenas a Central/);
 });
 test('server rejects executable firmware URL and malformed digest',async()=>{
  await db.query("select set_config('request.jwt.claim.sub',$1,true)",[u]);await db.exec("select set_config('test.admin','true',true);");
  await assert.rejects(save({firmware_url:'javascript:alert(1)'}),/HTTPS/);
  await db.exec('rollback;begin;');await db.query("select set_config('request.jwt.claim.sub',$1,true)",[u]);await db.exec("select set_config('test.admin','true',true);");
  await assert.rejects(save({firmware_sha256:'abc'}),/SHA-256/);
 });
 test('admin creates linked offline controller with price and metadata atomically',async()=>{
  await db.query("select set_config('request.jwt.claim.sub',$1,true)",[u]);await db.exec("select set_config('test.admin','true',true);");
  const r=(await db.query("select public.cadastrar_controlador_admin_vortex($1,'vtx-new','Novo aspirador',5,3,15,'{\"modelo\":\"ESP32\"}') as dados",[c])).rows[0].dados;
  const eq=(await db.query('select * from equipamentos where id=$1',[r.id])).rows[0];
  assert.equal(eq.cliente_id,c);assert.equal(eq.codigo,'VTX-NEW');assert.equal(eq.status,'offline');assert.equal(eq.comando,'aguardando');assert.equal(eq.preco_minuto,'5.00');
  assert.equal((await db.query('select modelo from vortex_dados_controlador where equipamento_id=$1',[r.id])).rows[0].modelo,'ESP32');
 });
 test('new controller denied to owner; invalid firmware rolls back whole registration',async()=>{
  await db.query("select set_config('request.jwt.claim.sub',$1,true)",[u]);
  await assert.rejects(db.query("select public.cadastrar_controlador_admin_vortex($1,'VTX-NEW','Novo',2,2,4)",[c]),/Apenas a Central/);
  await db.exec('rollback;begin;');await db.query("select set_config('request.jwt.claim.sub',$1,true)",[u]);await db.exec("select set_config('test.admin','true',true);savepoint tentativa;");
  await assert.rejects(db.query("select public.cadastrar_controlador_admin_vortex($1,'VTX-NEW','Novo',2,2,4,'{\"firmware_url\":\"javascript:bad\"}')",[c]),/HTTPS/);
  await db.exec('rollback to tentativa;');assert.equal((await db.query("select count(*)::int as n from equipamentos where codigo='VTX-NEW'")).rows[0].n,0);
 });
 test('admin updates client and receipt without account impersonation or role changes',async()=>{
  await db.query("select set_config('request.jwt.claim.sub',$1,true)",[u]);await db.exec("select set_config('test.admin','true',true);");
  const receipt={tipo_chave_pix:'email',chave_pix:'example@example.com',titular:'Cliente',banco:'Banco',documento_titular:'123',modo_cobranca:'minutos'};
  const r=(await db.query('select configuracoes_cliente_admin_vortex($1,$2,$3) as dados',[c,JSON.stringify({nome:' João ',mensalidade:75,tipo_usuario:'admin',user_id:e}),JSON.stringify(receipt)])).rows[0].dados;
  assert.equal(r.cliente.nome,'João');assert.equal(r.cliente.mensalidade,75);assert.equal(r.recebimento.modo_cobranca,'minutos');
  const profile=(await db.query('select user_id,tipo_usuario from clientes where id=$1',[c])).rows[0];assert.equal(profile.user_id,u);assert.equal(profile.tipo_usuario,'cliente');
  await db.query('select vortex_gerar_mensalidades_cliente($1)',[c]);assert.equal((await db.query('select valor from mensalidades where cliente_id=$1',[c])).rows[0].valor,'75.00');
 });
 test('owner cannot view administrative receipt RPC',async()=>{
  await db.query("select set_config('request.jwt.claim.sub',$1,true)",[u]);
  await assert.rejects(db.query('select configuracoes_cliente_admin_vortex($1)',[c]),/Apenas a Central/);
 });

}
