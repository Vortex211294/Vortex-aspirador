const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const html = fs.readFileSync(require('node:path').join(__dirname, '../index.html'), 'utf8');
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');

function ambiente({ tables = {}, rpc, invoke, auth } = {}) {
  const elementos = new Map(), consultas = [], chamadas = [], timers = new Map();
  let timerId = 0;
  const document = {
    body: { style: {}, classList: { toggle() {} } },
    getElementById(id) {
      if (!elementos.has(id)) elementos.set(id, elemento(id));
      return elementos.get(id);
    },
    querySelector() { return this.getElementById('selector'); },
    querySelectorAll() { return []; },
    createElement(tag) { return elemento(tag); }, execCommand() { return true; }
  };
  function elemento(id) {
    let text = '', markup = '';
    return { id, value: '', disabled: false, style: {}, dataset: {}, children: [],
      classList: { add() {}, remove() {}, toggle() {} },
      get textContent() { return text; }, set textContent(v) { text = String(v); markup = text; },
      get innerText() { return text; }, set innerText(v) { text = String(v); markup = text; },
      get innerHTML() { return markup; }, set innerHTML(v) { markup = String(v); text = markup; },
      checkValidity() { return !this.value || /.+@.+\..+/.test(this.value); },
      addEventListener() {}, scrollIntoView() {}, appendChild(e) { this.children.push(e); }, select() {}
    };
  }
  const db = {
    from(table) {
      const query = { table, filters: [], sorts: [], range: null };
      const builder = {
        select(columns) { query.columns = columns; return this; },
        eq(column, value) { query.filters.push({column, value}); return this; },
        in(column, values) { query.filters.push({column, values}); return this; },
        or(filter) { query.or = filter; return this; },
        order(column, options) { query.sorts.push({column, options}); return this; },
        limit(n) { query.limit = n; return this; },
        range(a,b) { query.range = [a,b]; return this; },
        single() { query.single = true; return this; },
        maybeSingle() { query.single = true; return this; },
        then(resolve, reject) {
          consultas.push(query);
          let result;
          try {
            const source = tables[table];
            if (typeof source === 'function') result = source(query);
            else if (source?.error) result = source;
            else {
              let rows = [...(source || [])];
              for (const f of query.filters) rows = rows.filter(r => f.values ? f.values.includes(r[f.column]) : r[f.column] === f.value);
              if (query.range) rows = rows.slice(query.range[0], query.range[1]+1);
              if (query.limit) rows = rows.slice(0,query.limit);
              result = { data: query.single ? rows[0] || null : rows, error: null };
            }
          } catch (err) { return Promise.reject(err).then(resolve,reject); }
          return Promise.resolve(result).then(resolve,reject);
        }
      };
      return builder;
    },
    rpc(name, payload) { chamadas.push({name,payload}); return rpc ? rpc(name,payload) : Promise.resolve({data:0,error:null}); },
    functions: { invoke(name, payload) { chamadas.push({name,payload}); return invoke ? invoke(name,payload) : Promise.resolve({data:null,error:null}); } },
    auth: {
      getUser: async () => ({ data: { user: { id: 'u1', email: 'teste@example.com' } } }),
      getSession: async () => ({ data: { session: null } }),
      signInWithPassword: async () => ({error:null}), signUp: async () => ({data:{},error:null}),
      signOut: async () => ({error:null}), ...auth
    }
  };
  const context = vm.createContext({document, Intl, Date, Promise, JSON, console: {error() {}},
    URL,
    window: { supabase: { createClient: () => db }, addEventListener() {}, innerWidth:1200 },
    navigator: { clipboard: { writeText: async () => {} } }, localStorage: {getItem(){return null;},setItem(){}},
    location: {origin:'https://example.com',pathname:'/',reload(){}}, alert() {},
    setTimeout(fn) { const id=++timerId;timers.set(id,fn);return id; }, clearTimeout(id){timers.delete(id);}
  });
  vm.runInContext(script, context);
  const run = code => vm.runInContext(code,context);
  run('clienteLogado = {id:"c1"}; usuarioEhAdmin = false;');
  const el = id => document.getElementById(id);
  return {run,el,db,consultas,chamadas,timers,context};
}

test('HTML has unique IDs, valid JS, and resolvable inline actions', () => {
  new vm.Script(script);
  const ids = [...html.matchAll(/\bid="([^"$]+)"/g)].map(m=>m[1]).filter(x=>!x.includes('${'));
  assert.equal(new Set(ids).size,ids.length);
  const a = ambiente();
  const actions = [...html.matchAll(/onclick="([\s\S]*?)"/g)].map(m=>m[1]);
  for (const action of actions) {
    const name=action.replace(/^event.stopPropagation\(\);/,'').match(/^([a-zA-Z]+)\(/)?.[1];
    if(name) assert.equal(a.run(`typeof ${name}`),'function',name);
  }
});

test('each client query is restricted; admin queries remain global', async () => {
  const a=ambiente();
  for(const table of ['equipamentos','pagamentos','repasses_clientes','mensalidades']) await a.run(`consultaClienteVortex('${table}')`);
  for(const q of a.consultas) assert.ok(q.filters.some(f=>f.column==='cliente_id'&&f.value==='c1'));
  a.run('usuarioEhAdmin=true');await a.run("consultaClienteVortex('pagamentos')");
  assert.equal(a.consultas.at(-1).filters.length,0);
});

test('controller shows command duration independently of the current price package', async () => {
  const e={id:'e1',cliente_id:'c1',comando:'ligar',tempo_minutos:1,valor_tempo:4,tempo_acionamento_segundos:180};
  const a=ambiente({tables:{equipamentos:[e]}});
  await a.run("carregarControladoresVortex('e1')");
  const painel=a.el('detalheControladorVortex').innerHTML;
  assert.match(painel,/Tempo do comando: 3 min/);
  assert.match(painel,/Pacote configurado: 1 min/);
  const b=ambiente({tables:{equipamentos:[{...e,tempo_acionamento_segundos:null}]}});
  await b.run("carregarControladoresVortex('e1')");
  assert.match(b.el('detalheControladorVortex').innerHTML,/Tempo do comando: --/);
});

test('pagination includes more than 1000 rows and discards incomplete results on failure', async () => {
  const records=Array.from({length:1127},(_,i)=>({id:i,cliente_id:'c1'}));
  const a=ambiente({tables:{pagamentos:records}});
  assert.equal((await a.run("buscarTodosVortex(() => consultaClienteVortex('pagamentos'))")).data.length,1127);
  const b=ambiente({tables:{pagamentos:q=>q.range[0]===100 ? {error:{message:'connection'},data:null} : {data:records.slice(0,100),error:null}}});
  const r=await b.run("buscarTodosVortex(() => consultaClienteVortex('pagamentos'))");
  assert.equal(r.data,null);assert.ok(r.error);
});

test('Brazil day does not change prematurely at UTC midnight', () => {
  const a=ambiente();
  assert.equal(a.run("chaveDataBrasilVortex('2026-10-06T01:30:00Z')"),'2026-10-05');
  assert.equal(a.run("chaveDataBrasilVortex('2026-10-06T03:00:00Z')"),'2026-10-06');
  assert.equal(a.run("chaveDataLocalVortex(inicioSemanaVortex(new Date('2026-10-05T12:00:00')))"),'2026-10-05');
});

test('stored text cannot create HTML or break an inline argument', () => {
  const a=ambiente();const out=a.run(`escaparHtml('<img src=x onerror=alert(1)>"&')`);
  assert.ok(!out.includes('<img'));assert.ok(out.includes('&quot;'));
  const arg=a.run(`argumentoJsVortex('Nome "A" & <B>')`);assert.ok(!arg.includes('<B>'));assert.ok(!arg.includes('"'));
});

test('switching PIX equipment updates amount and duration', () => {
  const a=ambiente();a.run('pixEquipamentosCacheVortex=[{id:"e1",preco_minuto:2,valor_tempo:4,tempo_minutos:2},{id:"e2",preco_minuto:3.5,valor_tempo:10.5,tempo_minutos:3}]');
  a.el('pixEquipamentoVortex').value='e2';a.run('atualizarCamposPixVortex()');
  assert.equal(a.el('pixValorFixoVortex').value,'10.50');assert.equal(a.el('pixMinutosFixosVortex').value,3);
  a.run('pixModoVortex="minutos"');a.el('pixQtdMinutosVortex').value='3';
  const data=a.run('obterDadosPixVortex()');assert.equal(data.valor,10.5);assert.equal(data.equipamento_id,'e2');
});

test('PIX rejects fractions, infinity, and equipment absent from current account', () => {
  const a=ambiente();a.run('pixEquipamentosCacheVortex=[{id:"e1",preco_minuto:2,tempo_minutos:2,valor_tempo:4}]');a.el('pixEquipamentoVortex').value='e1';
  a.el('pixValorFixoVortex').value='5';a.el('pixMinutosFixosVortex').value='1.5';assert.throws(()=>a.run('obterDadosPixVortex()'));
  a.el('pixMinutosFixosVortex').value='2';a.el('pixValorFixoVortex').value='Infinity';assert.throws(()=>a.run('obterDadosPixVortex()'));
  a.el('pixValorFixoVortex').value='5';a.el('pixEquipamentoVortex').value='other';assert.throws(()=>a.run('obterDadosPixVortex()'));
});

test('PIX cannot be submitted twice while creation is pending', async () => {
  let finish;const a=ambiente({invoke:()=>new Promise(r=>finish=r)});
  a.run('pixEquipamentosCacheVortex=[{id:"e1",preco_minuto:2,tempo_minutos:2,valor_tempo:4}]');a.el('pixEquipamentoVortex').value='e1';a.el('pixValorFixoVortex').value='4';a.el('pixMinutosFixosVortex').value='2';
  const first=a.run('gerarPixRealVortex()');await a.run('gerarPixRealVortex()');assert.equal(a.chamadas.length,1);
  finish({data:{error:'provider refused'},error:null});await first;
  assert.equal(a.el('btnGerarPixVortex').disabled,false);assert.match(a.el('resumoPixVortex').textContent,/Não foi possível/);
});

test('PIX displays the function response on HTTP failures and restores its button', async () => {
  const a=ambiente({invoke:async()=>({data:null,error:{message:'Edge Function returned a non-2xx status code',context:{json:async()=>({sucesso:false,erro:'Cadastro VORTEX não encontrado'})}}})});
  a.run('pixEquipamentosCacheVortex=[{id:"e1",preco_minuto:2,tempo_minutos:2,valor_tempo:4}]');a.el('pixEquipamentoVortex').value='e1';a.el('pixValorFixoVortex').value='4';a.el('pixMinutosFixosVortex').value='2';
  await a.run('gerarPixRealVortex()');
  assert.match(a.el('resumoPixVortex').textContent,/Cadastro VORTEX não encontrado/);
  assert.doesNotMatch(a.el('resumoPixVortex').textContent,/non-2xx/);
  assert.equal(a.el('btnGerarPixVortex').disabled,false);
  assert.equal(a.timers.size,0);
});

test('PIX handles Portuguese response errors and an unreadable HTTP response', async () => {
  const a=ambiente({invoke:async()=>({data:{sucesso:false,erro:'Equipamento indisponível'},error:null})});
  a.run('pixEquipamentosCacheVortex=[{id:"e1",preco_minuto:2,tempo_minutos:2,valor_tempo:4}]');a.el('pixEquipamentoVortex').value='e1';a.el('pixValorFixoVortex').value='4';a.el('pixMinutosFixosVortex').value='2';
  await a.run('gerarPixRealVortex()');
  assert.match(a.el('resumoPixVortex').textContent,/Equipamento indisponível/);
  assert.equal(a.timers.size,0);
  a.db.functions.invoke=async()=>({data:null,error:{message:'Edge Function returned a non-2xx status code',context:{json:async()=>{throw new Error('not JSON')}}}});
  await a.run('gerarPixRealVortex()');
  assert.match(a.el('resumoPixVortex').textContent,/serviço PIX/);
  assert.equal(a.el('btnGerarPixVortex').disabled,false);
});

test('old PIX monitor cannot overwrite a new transaction or send a motor command', async () => {
  let resolveOld;
  const a=ambiente({tables:{pagamentos:q=>q.filters.some(f=>f.value==='old') ? new Promise(r=>resolveOld=r) : {data:{status:'WAITING'},error:null}}});
  a.run('pixReferenciaAtualVortex="old";monitorarPagamentoPixVortex("old")');
  await new Promise(r=>setImmediate(r));
  a.run('pixReferenciaAtualVortex="new";monitorarPagamentoPixVortex("new")');
  resolveOld({data:{status:'PAID'},error:null});await new Promise(r=>setImmediate(r));
  assert.doesNotMatch(a.el('pixStatusRealVortex').textContent,/confirmado/);
  assert.equal(a.chamadas.length,0);
});

test('copying PIX leaves a confirmed payment status intact', async () => {
  const a=ambiente();a.el('pixStatusRealVortex').textContent='PIX confirmado';a.el('pixCopiaColaVortex').value='000201';
  await a.run('copiarPixVortex()');assert.equal(a.el('pixStatusRealVortex').textContent,'PIX confirmado');
  assert.equal(a.el('pixCopiaMensagemVortex').textContent,'PIX copiado.');
});

test('remote command validates integers and recovers after a network rejection', async () => {
  const a=ambiente({rpc:()=>Promise.reject(new Error('network'))});a.run('equipamentoAcionamentoId="e1"');
  a.el('tempoAcionamentoVortex').value='1.5';await a.run('confirmarAcionamentoVortex()');assert.equal(a.chamadas.length,0);
  a.el('tempoAcionamentoVortex').value='2';await a.run('confirmarAcionamentoVortex()');
  assert.equal(a.el('btnConfirmarAcionamentoVortex').disabled,false);assert.match(a.el('mensagemAcionamentoVortex').textContent,/Não foi possível/);
  assert.equal(a.chamadas[0].payload.p_tempo_segundos,120);
});

test('login reports confirmation requirement and recovers after a thrown network error', async () => {
  const a=ambiente({auth:{signInWithPassword:async()=>({error:{code:'email_not_confirmed'}})}});
  a.el('loginEmail').value='teste@example.com';a.el('loginSenha').value='example-password';await a.run('login()');
  assert.match(a.el('loginMsg').textContent,/Confirme/);assert.equal(a.el('btnLoginVortex').disabled,false);
  a.db.auth.signInWithPassword=async()=>{throw new Error('network');};await a.run('login()');
  assert.equal(a.el('btnLoginVortex').disabled,false);assert.notEqual(a.el('loginMsg').textContent,'Entrando...');
});

test('financial errors show unavailable instead of a false zero', async () => {
  const a=ambiente({tables:{pagamentos:[],repasses_clientes:{error:{message:'denied'},data:null},mensalidades:[]},rpc:async()=>({data:null,error:{message:'denied'}})});
  await a.run('carregarFinanceiroModuloVortex()');const out=a.el('financeiroModuloVortex').innerHTML;
  assert.match(out,/Saldo disponível para repasse<\/div><strong>—/);assert.match(out,/Repasses concluídos<\/div><strong>—/);
});

test('reports reject reversed periods and retain an error instead of reporting no sales', async () => {
  const a=ambiente({tables:{pagamentos:{error:{message:'network'},data:null}}});
  a.el('relatorioDataInicioVortex').value='2026-10-10';a.el('relatorioDataFimVortex').value='2026-10-01';await a.run('gerarRelatorioVortex()');
  assert.equal(a.consultas.length,0);assert.match(a.el('relatorioVortexResultado').textContent,/período válido/);
  a.el('relatorioDataInicioVortex').value='2026-10-01';await a.run('gerarRelatorioVortex()');
  assert.match(a.el('relatorioVortexResultado').textContent,/Não foi possível/);assert.equal(a.run('relatorioAtualVortex'),null);
});

test('report queries include Brazil end-of-day boundary and client restriction', async () => {
  const a=ambiente();a.el('relatorioDataInicioVortex').value='2026-10-01';a.el('relatorioDataFimVortex').value='2026-10-05';
  await a.run('gerarRelatorioVortex()');const q=a.consultas.find(q=>q.table==='pagamentos');
  assert.match(q.or,/23:59:59\.999-03:00/);assert.ok(q.filters.some(f=>f.column==='cliente_id'&&f.value==='c1'));
});

test('settings load from server and roundtrip the full form', async () => {
  const a=ambiente({rpc:async(name)=>({data:name==='obter_recebimento_vortex'?{tipo_chave_pix:'aleatoria',chave_pix:'example',titular:'Teste',banco:'Banco',documento_titular:'123',modo_cobranca:'minutos'}:null,error:null})});
  await a.run('carregarConfiguracoesLocaisVortex()');assert.equal(a.el('configBancoVortex').value,'Banco');assert.equal(a.el('configDocumentoTitularVortex').value,'123');
  await a.run('salvarConfiguracoesContaVortex()');assert.equal(a.chamadas.at(-1).payload.p_chave_pix,'example');
  assert.equal(a.chamadas.at(-1).name,'salvar_recebimento_vortex');
});

test('main panel scopes reads and clears empty equipment/session screens', async () => {
  const a=ambiente({tables:{clientes:[{id:'c1',user_id:'u1',nome:'Teste',tipo_usuario:'cliente'}],equipamentos:[],pagamentos:[],sessoes:[],mensalidades:[]}});
  a.el('listaEquipamentosPagina').innerHTML='old equipment';a.el('listaSessoes').innerHTML='old sessions';
  await a.run('abrirPainel()');assert.match(a.el('listaEquipamentosPagina').innerHTML,/Nenhum equipamento/);assert.match(a.el('listaSessoes').innerHTML,/Nenhuma sessão/);
  for (const q of a.consultas.filter(q=>['equipamentos','pagamentos'].includes(q.table))) assert.ok(q.filters.some(f=>f.column==='cliente_id'&&f.value==='c1'));
});

test('main panel preserves the profile-not-linked message', async () => {
  const a=ambiente();await a.run('abrirPainel()');assert.match(a.el('loginMsg').textContent,/não foi vinculado/);
});


test('owner can save R$1 or R$5 per minute and the next PIX follows saved configuration', async () => {
  const a=ambiente({rpc:async(name,payload)=>({data:{id:payload.p_equipamento_id,preco_minuto:payload.p_preco_minuto,tempo_minutos:payload.p_tempo_minutos,valor_tempo:payload.p_valor_tempo},error:null})});
  a.run('pixEquipamentosCacheVortex=[{id:"e1",preco_minuto:2,tempo_minutos:2,valor_tempo:4}];window.vortexEquipamentosAtuais=[{id:"e1",preco_minuto:2,tempo_minutos:2,valor_tempo:4}];pixModoVortex="minutos"');
  a.el('pixEquipamentoVortex').value='e1';a.run('atualizarCamposPixVortex()');
  a.el('pixQtdMinutosVortex').value='3';
  for (const preco of [1,5]) {
    a.el('pixPrecoMinutoVortex').value=String(preco);
    assert.throws(()=>a.run('obterDadosPixVortex()'),/Salvar preços/);
    await a.run('salvarPrecosPixVortex()');
    assert.equal(a.chamadas.at(-1).name,'salvar_precos_equipamento_vortex');
    assert.equal(a.chamadas.at(-1).payload.p_preco_minuto,preco);
    assert.equal(a.run('window.vortexEquipamentosAtuais[0].preco_minuto'),preco);
    const compra=a.run('obterDadosPixVortex()');assert.equal(compra.valor,preco*3);assert.equal(compra.minutos,3);
    assert.match(a.el('mensagemPrecosPixVortex').textContent,/Configuração salva/);
  }
});

test('failed configuration save retains the saved price and blocks changed draft PIX',async()=>{
  const a=ambiente({rpc:async()=>({data:null,error:{message:'Sem permissão'}})});
  a.run('pixEquipamentosCacheVortex=[{id:"e1",preco_minuto:2,tempo_minutos:2,valor_tempo:4}];pixModoVortex="minutos"');
  a.el('pixEquipamentoVortex').value='e1';a.run('atualizarCamposPixVortex()');a.el('pixQtdMinutosVortex').value='1';a.el('pixPrecoMinutoVortex').value='5';
  await a.run('salvarPrecosPixVortex()');assert.equal(a.run('pixEquipamentosCacheVortex[0].preco_minuto'),2);
  assert.match(a.el('mensagemPrecosPixVortex').textContent,/Sem permissão/);assert.throws(()=>a.run('obterDadosPixVortex()'),/Salvar preços/);
  assert.equal(a.el('btnSalvarPrecosPixVortex').disabled,false);assert.equal(a.el('pixPrecoMinutoVortex').disabled,false);
});

test('saving prices blocks generation until server confirms and preserves a purchased PIX',async()=>{
  let finish;const a=ambiente({rpc:()=>new Promise(r=>finish=r)});
  a.run('pixEquipamentosCacheVortex=[{id:"e1",preco_minuto:2,tempo_minutos:2,valor_tempo:4}];pixReferenciaAtualVortex="ORDE_OLD"');
  a.el('pixEquipamentoVortex').value='e1';a.run('atualizarCamposPixVortex()');a.el('pixPrecoMinutoVortex').value='1';a.el('resumoPixVortex').textContent='QR antigo R$4';
  const saving=a.run('salvarPrecosPixVortex()');await a.run('salvarPrecosPixVortex()');assert.equal(a.chamadas.length,1);
  assert.throws(()=>a.run('obterDadosPixVortex()'),/Aguarde/);
  finish({data:{id:'e1',preco_minuto:1,tempo_minutos:2,valor_tempo:4},error:null});await saving;
  assert.equal(a.el('resumoPixVortex').textContent,'QR antigo R$4');assert.equal(a.run('pixReferenciaAtualVortex'),'ORDE_OLD');
});

test('equipment and ADMIN forms save the per-minute price, fixed amount, and fixed minutes together',async()=>{
  const a=ambiente({rpc:async(name,p)=>({data:{id:p.p_equipamento_id,preco_minuto:p.p_preco_minuto,tempo_minutos:p.p_tempo_minutos,valor_tempo:p.p_valor_tempo},error:null})});
  for(const admin of [false,true]) {
    a.run('usuarioEhAdmin='+admin);const prefix=admin?'admin-':'';
    a.el(prefix+'preco-e1').value='5';a.el(prefix+'tempo-e1').value='4';a.el(prefix+'valor-e1').value='12';
    await a.run('salvarConfiguracaoVortex("e1",'+admin+')');
    assert.equal(a.chamadas.at(-1).payload.p_preco_minuto,5);assert.equal(a.chamadas.at(-1).payload.p_valor_tempo,12);assert.equal(a.chamadas.at(-1).payload.p_tempo_minutos,4);
    assert.match(a.el(prefix+'mensagem-e1').textContent,/Configuração salva/);
  }
});


test('monthly screen shows paid current cycle separately from next pending bill',async()=>{
  const a=ambiente({tables:{clientes:[{id:'c1',user_id:'u1',nome:'Teste',tipo_usuario:'cliente'}],mensalidades:[
    {id:'m2',cliente_id:'c1',vencimento:'2099-10-31',valor:50,valor_descontado:0,status:'pendente'},
    {id:'m1',cliente_id:'c1',vencimento:'2000-10-01',valor:50,valor_descontado:50,status:'pago'}]}});
  await a.run('abrirPainel()');
  assert.equal(a.el('mensalidadeStatus').textContent,'Status: pago');
  assert.match(a.el('mensalidadeDescontado').textContent,/50,00/);
  assert.match(a.el('mensalidadeRestante').textContent,/0,00/);
  assert.equal(a.el('mensalidadeProxima').textContent,'Próximo vencimento: 31/10/2099');
  for(const q of a.consultas.filter(q=>q.table==='mensalidades'))assert.ok(q.filters.some(f=>f.column==='cliente_id'&&f.value==='c1'));
});

test('monthly screen keeps earliest partial debt visible and shows remaining cents',async()=>{
  const a=ambiente({tables:{mensalidades:[
    {id:'m2',cliente_id:'c1',vencimento:'2099-10-31',valor:50,valor_descontado:0,status:'pendente'},
    {id:'m1',cliente_id:'c1',vencimento:'2000-10-01',valor:50,valor_descontado:19.40,status:'pendente'}]}});
  const response=await a.run("buscarMensalidadesClienteVortex('c1')");
  a.context.monthlyResponse=response;a.run('renderizarMensalidadeVortex(monthlyResponse)');
  assert.equal(a.el('mensalidadeVencimento').textContent,'Vencimento: 01/10/2000');
  assert.equal(a.el('mensalidadeStatus').textContent,'Status: parcialmente paga');
  assert.match(a.el('mensalidadeDescontado').textContent,/19,40/);
  assert.match(a.el('mensalidadeRestante').textContent,/30,60/);
  a.run('renderizarMensalidadeVortex({data:null,error:{message:"offline"}})');
  assert.equal(a.el('mensalidadeStatus').textContent,'Status: consulta indisponível');
  for(const id of ['mensalidadeDescontado','mensalidadeRestante','mensalidadeProxima'])assert.equal(a.el(id).textContent,'');
});

test('monthly query failure in Central is explicit instead of showing an invented status',async()=>{
  const a=ambiente({tables:{clientes:[{id:'c1',nome:'Teste'}],mensalidades:{data:null,error:{message:'denied'}}}});
  a.run('usuarioEhAdmin=true');await a.run("abrirClienteAdmin('c1')");
  assert.match(a.el('detalheClienteResumo').innerHTML,/Consulta indisponível/);
});

test('hour charts use only confirmed payments in Brazil current week, retain cents and omit invalid dates', () => {
  const a=ambiente();
  const out=a.run(`pontosHorariosVortex([
    {status:'PAID',pago_em:'2026-10-06T01:30:00Z',valor_bruto:4.25,minutos:2,equipamento_id:'e1'},
    {status:'WAITING',pago_em:'2026-10-06T12:00:00Z',valor_bruto:10},
    {status:'PAID',pago_em:'invalid'},
    {status:'PAID',pago_em:'2026-09-30T12:00:00Z'},
    {status:'PAID',pago_em:'2026-10-06T03:00:00Z',valor_bruto:1,minutos:1,equipamento_id:'e1'}
  ], ['2026-10-05','2026-10-06','2026-10-07','2026-10-08','2026-10-09','2026-10-10','2026-10-11'],'e1')`);
  assert.equal(out.length,2); assert.equal(out[0].x,0); assert.equal(out[0].hora,'22:30');
  assert.equal(out[0].y,22.5); assert.equal(out[0].valor,4.25);assert.equal(out[1].hora,'00:00');
  const options=a.run('opcoesGraficoHorariosVortex([])');
  assert.equal(options.scales.y.ticks.callback(3),'03:00');assert.equal(options.scales.x.ticks.callback(0),'Seg');
  assert.equal(options.scales.x.grid.display,true);
});

test('admin controller data reloads from database and saves through authorized RPC without motor command', async () => {
  const config={equipamento_id:'e1',modelo:'ESP32',serial:'S1',firmware_versao:'1.0'};
  const a=ambiente({tables:{equipamentos:[{id:'e1',cliente_id:'c1'}],vortex_dados_controlador:[config]},rpc:async(name,p)=>({data:{...p.p_dados,equipamento_id:p.p_equipamento_id},error:null})});
  a.run('usuarioEhAdmin=true');await a.run("carregarControladoresVortex('e1')");a.run("abrirDadosControladorVortex('e1')");
  assert.match(a.el('dadosControladorFormularioVortex').innerHTML,/ESP32/);
  for(const key of ['modelo','serial','ssid','ip','mac','firmware_versao','firmware_url','firmware_sha256','observacoes']) a.el('controladorCampo_'+key).value='';
  a.el('controladorCampo_modelo').value=' ESP32 ';a.el('controladorCampo_firmware_url').value='https://example.com/firmware.bin';
  await a.run("salvarDadosControladorVortex('e1')");
  assert.equal(a.chamadas.length,1);assert.equal(a.chamadas[0].name,'salvar_dados_controlador_vortex');
  assert.equal(a.chamadas[0].payload.p_dados.modelo,'ESP32');assert.match(a.el('dadosControladorMensagemVortex').textContent,/salvos/);
  assert.equal(a.consultas.find(q=>q.table==='vortex_dados_controlador').sorts[0].column,'equipamento_id');
});

test('firmware unsafe URLs and failed saves cannot claim success or leave save blocked', async () => {
  const a=ambiente({tables:{equipamentos:[{id:'e1',cliente_id:'c1'}]},rpc:async()=>({data:null,error:{message:'Sem permissão'}})});
  a.run('usuarioEhAdmin=true');await a.run("carregarControladoresVortex('e1')");a.run("abrirDadosControladorVortex('e1')");
  a.el('controladorCampo_firmware_url').value='javascript:alert(1)';await a.run("salvarDadosControladorVortex('e1')");
  assert.equal(a.chamadas.length,0);assert.match(a.el('dadosControladorMensagemVortex').textContent,/HTTPS/);
  a.el('controladorCampo_firmware_url').value='https://user:password@example.com/file';await a.run("salvarDadosControladorVortex('e1')");assert.equal(a.chamadas.length,0);
  a.el('controladorCampo_firmware_url').value='';await a.run("salvarDadosControladorVortex('e1')");
  assert.match(a.el('dadosControladorMensagemVortex').textContent,/Sem permissão/);assert.equal(a.el('salvarDadosControladorBotao').disabled,false);
});


test('client can see registered controller data but cannot open or save registration',async()=>{
 const a=ambiente({tables:{equipamentos:[{id:'e1',cliente_id:'c1'}],vortex_dados_controlador:[{equipamento_id:'e1',modelo:'ESP32',firmware_versao:'1.2'}]}});
 await a.run("carregarControladoresVortex('e1')");assert.match(a.el('detalheControladorVortex').innerHTML,/ESP32/);
 assert.ok(!a.el('detalheControladorVortex').innerHTML.includes('>Dados e firmware</button>'));
 a.run("abrirDadosControladorVortex('e1')");assert.equal(a.el('dadosControladorFormularioVortex').innerHTML,'');
 await a.run("salvarDadosControladorVortex('e1')");assert.equal(a.chamadas.length,0);
});


test('Central client search ignores accents, matches formatted phones, and restores all results',()=>{
 const a=ambiente();a.run(`usuarioEhAdmin=true;clientesAdminCacheVortex=[{id:'c1',nome:'João Proença',telefone:'(15) 99999-1234'},{id:'c2',nome:'Ana',telefone:'11988887777'}]`);
 for(const term of ['JOAO','proenca','15999991234']) {
   a.el('pesquisaClientesVortex').value=term;a.run('filtrarClientesAdminVortex()');
   assert.match(a.el('listaClientesAdmin').innerHTML,/João/);assert.ok(!a.el('listaClientesAdmin').innerHTML.includes('>Ana<'));
   assert.equal(a.el('resultadoPesquisaClientesVortex').textContent,'1 de 2 cliente(s).');
 }
 a.el('pesquisaClientesVortex').value='inexistente';a.run('filtrarClientesAdminVortex()');assert.match(a.el('listaClientesAdmin').innerHTML,/Nenhum cliente/);
 a.el('pesquisaClientesVortex').value='';a.run('filtrarClientesAdminVortex()');assert.equal(a.el('resultadoPesquisaClientesVortex').textContent,'2 de 2 cliente(s).');
 assert.match(a.el('listaClientesAdmin').innerHTML,/abrirClienteAdmin/);
});


test('admin registration validates then saves correct selected client and prices',async()=>{
 const a=ambiente({tables:{clientes:[{id:'c1',nome:'João',ativo:true}],equipamentos:[]},rpc:async(name,p)=>({data:{id:'e2',cliente_id:p.p_cliente_id},error:null})});
 a.run('usuarioEhAdmin=true');await a.run("abrirNovoControladorAdminVortex('c1')");assert.match(a.el('novoControladorFormularioVortex').innerHTML,/João/);
 for(const [id,value]of Object.entries({novoControladorClienteVortex:'c1',novoControladorCodigoVortex:'VTX-NEW',novoControladorNomeVortex:'Novo',novoControladorPrecoVortex:'5',novoControladorTempoVortex:'3',novoControladorValorVortex:'15'}))a.el(id).value=value;
 await a.run('cadastrarNovoControladorAdminVortex()');assert.equal(a.chamadas[0].name,'cadastrar_controlador_admin_vortex');assert.equal(a.chamadas[0].payload.p_cliente_id,'c1');assert.equal(a.chamadas[0].payload.p_preco_minuto,5);assert.equal(a.el('novoControladorSalvarVortex').disabled,false);
 a.run('usuarioEhAdmin=false');await a.run('cadastrarNovoControladorAdminVortex()');assert.equal(a.chamadas.length,1);
});
test('admin client editing saves to selected client instead of signed-in ADM account',async()=>{
 const a=ambiente({rpc:async(name,p)=>({data:{cliente:{id:p.p_cliente_id,nome:'João',ativo:true,mensalidade:50},recebimento:null},error:null})});
 a.run('usuarioEhAdmin=true;clienteAdminSelecionado="c2"');await a.run('abrirConfiguracoesClienteAdminVortex()');assert.match(a.el('configuracoesClienteAdminFormularioVortex').innerHTML,/Configurações do cliente/);
 a.el('adminCliente_nome').value='João';a.el('adminCliente_mensalidade').value='50';a.el('adminCliente_ativo').value='true';
 await a.run("salvarConfiguracoesClienteAdminVortex('cadastro')");assert.equal(a.chamadas.at(-1).payload.p_cliente_id,'c2');assert.equal(a.chamadas.at(-1).payload.p_dados.nome,'João');assert.match(a.el('adminClienteMensagemVortex').textContent,/salvas/);
 a.run('usuarioEhAdmin=false');await a.run("salvarConfiguracoesClienteAdminVortex('cadastro')");assert.equal(a.chamadas.length,2);
});
