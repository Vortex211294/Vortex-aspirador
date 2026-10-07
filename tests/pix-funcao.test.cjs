const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const source = fs.readFileSync(require('node:path').join(__dirname, '../supabase/functions/criar-pix-vortex/index.ts'), 'utf8').replace(/^import[^\n]+\n/, '');

function setup({owner = 'c1', metadata = {nome:'Pagador de teste',cpf_cnpj:'12345678909'}, providerStatus = 201, insertError = null, precoMinuto = 2, tempoFixo = 2, valorFixo = 4} = {}) {
  let handler, sent, inserted;
  const equipment = {id:'e1',cliente_id:owner,codigo:'VTX-000001',nome:'Teste',preco_minuto:precoMinuto,tempo_minutos:tempoFixo,valor_tempo:valorFixo};
  const profile = {id:'c1',nome:'Cadastro de teste',tipo_usuario:'cliente',ativo:true};
  const client = {
    auth: {getUser:async()=>({data:{user:{id:'u1',email:'teste@example.com',user_metadata:metadata}},error:null})},
    from(table) {
      return {
        select(){return this;},eq(){return this;},
        maybeSingle:async()=>({data:table==='clientes'?profile:equipment,error:null}),
        insert:async(data)=>{inserted=data;return {error:insertError};}
      };
    }
  };
  vm.runInNewContext(source,{
    createClient:()=>client,
    Deno:{env:{get:n=>({PAGBANK_TOKEN:' token-de-teste ',SUPABASE_URL:'https://example.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'test-only'}[n])},serve:fn=>{handler=fn;}},
    Response,Request,crypto:webcrypto,Date,console:{error(){}},
    fetch:async(url,options)=>{
      sent={url,options,body:JSON.parse(options.body)};
      const body=providerStatus===201 ? {id:'ORDE_TESTE',charges:[{id:'CHAR_TESTE',status:'WAITING',qr_code:{id:'QRCO_TESTE',text:'QR de teste'}}]} : {error_messages:[{code:'UNAUTHORIZED',description:'Invalid credential'}]};
      return Response.json(body,{status:providerStatus});
    }
  });
  return {
    async call(payload={},signed=true) {
      const request=new Request('https://example.com/pix',{method:'POST',headers:{'Content-Type':'application/json',...(signed?{Authorization:'Bearer teste'}:{})},body:JSON.stringify({equipamento_id:'e1',modo:'minutos',minutos:1,valor:2,...payload})});
      const response=await handler(request);
      return {status:response.status,body:await response.json()};
    },
    get sent(){return sent;},get inserted(){return inserted;}
  };
}
test('PIX sends the real authenticated profile to Sandbox and persists matching cents',async()=>{
  const a=setup();const response=await a.call({customer:{tax_id:'ignorado'}});
  assert.equal(response.status,200);
  assert.equal(a.sent.url,'https://sandbox.api.pagseguro.com/orders');
  assert.equal(a.sent.options.headers.Authorization,'Bearer token-de-teste');
  assert.deepEqual(a.sent.body.customer,{name:'Pagador de teste',email:'teste@example.com',tax_id:'12345678909'});
  assert.equal(a.sent.body.charges[0].amount.value,200);
  assert.equal(a.inserted.comissao_vortex,0.06);
  assert.equal(a.inserted.valor_cliente,1.94);
  assert.equal(response.body.referencia_pagbank,a.inserted.referencia_pagbank);
});
test('unauthenticated callers and clients of another owner cannot create PIX',async()=>{
  const a=setup();assert.equal((await a.call({},false)).status,401);assert.equal(a.sent,undefined);
  const b=setup({owner:'another-client'});assert.equal((await b.call()).status,403);assert.equal(b.sent,undefined);
});
test('both fixed and variable prices are enforced from database configuration',async()=>{
  const a=setup();assert.equal((await a.call({valor:0.01})).status,409);assert.equal(a.sent,undefined);
  assert.equal((await a.call({modo:'fixo',minutos:1,valor:4})).status,400);
  assert.equal((await a.call({modo:'fixo',minutos:2,valor:0.01})).status,409);
  assert.equal((await a.call({modo:'fixo',minutos:2,valor:4})).status,200);
  assert.equal(a.sent.body.charges[0].amount.value,400);
});
test('missing payer CPF/CNPJ is reported before contacting PagBank',async()=>{
  const a=setup({metadata:{nome:'Teste'}});const r=await a.call();
  assert.equal(r.status,400);assert.match(r.body.erro,/CPF\/CNPJ/);assert.equal(a.sent,undefined);
});
test('provider credential rejection cannot create a VORTEX payment',async()=>{
  const a=setup({providerStatus:401});const r=await a.call();
  assert.equal(r.status,502);assert.equal(r.body.pagbank_status,401);assert.equal(a.inserted,undefined);
});
test('database write failure does not return a payable QR to the app',async()=>{
  const a=setup({insertError:{code:'test',message:'failed'}});const r=await a.call();
  assert.equal(r.status,500);assert.equal(r.body.pedido_id,'ORDE_TESTE');assert.equal(r.body.pix_copia_cola,undefined);
});

test('saved R$1 and R$5 prices generate correct dynamic charges and purchased minutes',async()=>{
  for(const precoMinuto of [1,5]) {
    const a=setup({precoMinuto});const r=await a.call({minutos:3,valor:precoMinuto*3});
    assert.equal(r.status,200);assert.equal(a.sent.body.charges[0].amount.value,precoMinuto*300);
    assert.equal(a.inserted.minutos,3);assert.equal(a.inserted.valor_bruto,precoMinuto*3);
  }
  const fixo=setup({precoMinuto:5,tempoFixo:4,valorFixo:12});
  assert.equal((await fixo.call({modo:'fixo',minutos:4,valor:12})).status,200);
  assert.equal(fixo.inserted.minutos,4);assert.equal(fixo.inserted.valor_bruto,12);
});
