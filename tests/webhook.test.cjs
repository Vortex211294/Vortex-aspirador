const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const assert = require('node:assert/strict');
const {test} = require('node:test');
const {webcrypto,createHash,generateKeyPairSync,sign} = require('node:crypto');
const source=fs.readFileSync(path.join(__dirname,'../supabase/functions/pagbank-webhook/index.ts'),'utf8').replace(/^import[^\n]+\n/,'');
const token='test-only-token';
const keys=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
const public_key=keys.publicKey.export({type:'spki',format:'der'}).toString('base64');
const order='ORDE_TESTE';
const charge='CHAR_1563A40F-E026-48A8-8A2F-87BDCFB79565';
function setup(options={}) {
  let handler,updates=0,queries=0,fetches=[],logs=[];
  const payment={id:'p1',status:options.localStatus||'WAITING',valor_bruto:4};
  const provider={id:order,charges:[{id:charge,status:options.providerStatus||'PAID',payment_method:{type:'PIX'},amount:{value:options.amount??400,currency:options.currency||'BRL',summary:{paid:options.paid??400,refunded:0}}}]};
  const db={from(table){assert.equal(table,'pagamentos');let patch=null;const filters=[];return {
    select(){if(!patch)return this;assert.ok(filters.some(([k,v])=>k==='status'&&v===payment.status));return Promise.resolve({data:options.race?[]:[{id:payment.id,status:patch.status}],error:null});},
    eq(k,v){filters.push([k,v]);return this;},is(k,v){filters.push([k,v]);return this;},
    async maybeSingle(){queries++;return {data:options.missing?null:payment,error:null};},
    update(p){patch=p;updates++;assert.equal(p.status,provider.charges[0].status);return this;}
  };}};
  vm.runInNewContext(options.production ? source.replace('const API = "https://sandbox.api.pagseguro.com";', 'const API = "https://api.pagseguro.com";') : source,{createClient:()=>db,Deno:{env:{get:n=>({PAGBANK_TOKEN:` ${token} `,SUPABASE_URL:'https://test.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'test-only'}[n])},serve:fn=>handler=fn},Response,Request,Uint8Array,TextDecoder,TextEncoder,AbortSignal,atob,Date,crypto:webcrypto,console:{error(){},log(...args){logs.push(args);}},fetch:async(url,opts)=>{fetches.push(url);assert.equal(opts.headers.Authorization,`Bearer ${token}`);assert.ok(url.startsWith('https://sandbox.api.pagseguro.com/'));return url.includes('public-keys')?Response.json({public_key}):Response.json(provider,{status:options.providerHttp||200});}});
  return {
    async call({mode='legacy',event={id:order,charges:[{id:charge,status:'PAID'}]},alterBody=false,headers={}}={}) {
      const raw=JSON.stringify({...event,description:'Confirmação PIX'});
      const signature=mode==='ecdsa'?{'x-payload-signature':sign('sha256',Buffer.from(raw),keys.privateKey).toString('base64')}:mode==='legacy'?{'x-authenticity-token':createHash('sha256').update(`${token}-${raw}`).digest('hex')}:{};
      const response=await handler(new Request('https://test.com/webhook',{method:'POST',headers:{...signature,...headers},body:raw+(alterBody?' ':'')}));
      return {status:response.status,body:await response.json()};
    },get logs(){return logs;},get updates(){return updates;},get queries(){return queries;},get fetches(){return fetches;}
  };
}
test('legacy SHA256 over exact UTF8 body confirms payment using Sandbox lookup',async()=>{const a=setup();assert.equal((await a.call()).status,200);assert.equal(a.updates,1);assert.ok(a.fetches[0].endsWith(`/orders/${order}`));});
test('real ECDSA DER signature is verified with Sandbox public key',async()=>{const a=setup();assert.equal((await a.call({mode:'ecdsa'})).status,200);assert.ok(a.fetches[0].endsWith('/public-keys?type=webhook'));assert.equal(a.updates,1);});
test('altered signed body never queries or updates database',async()=>{for(const mode of ['legacy','ecdsa']){const a=setup();assert.equal((await a.call({mode,alterBody:true})).status,401);assert.equal(a.updates,0);assert.equal(a.queries,0);}});
test('invalid new signature cannot fall back to a valid legacy hash',async()=>{const a=setup();assert.equal((await a.call({headers:{'x-payload-signature':'invalid'}})).status,401);assert.equal(a.updates,0);});
test('wrong amount, currency, or paid total cannot mark PAID',async()=>{for(const opts of [{amount:1},{currency:'USD'},{paid:200}]){const a=setup(opts);assert.equal((await a.call()).status,409);assert.equal(a.updates,0);}});
test('early callback, provider lag, and failed lookup must retry rather than ACK',async()=>{for(const opts of [{missing:true},{providerStatus:'WAITING'},{providerHttp:401}]){const a=setup(opts);assert.equal((await a.call()).status,503);assert.equal(a.updates,0);}});
test('repeated PAID and late WAITING cannot update a PAID record',async()=>{for(const opts of [{localStatus:'PAID'},{localStatus:'PAID',providerStatus:'WAITING'}]){const a=setup(opts);assert.equal((await a.call({event:{id:order,charges:[{id:charge,status:opts.providerStatus||'PAID'}]}})).status,200);assert.equal(a.updates,0);}});
test('charge notifications resolve parent order without following body links',async()=>{const a=setup();assert.equal((await a.call({event:{id:charge,status:'PAID',links:[{href:'http://unsafe.example'}]}})).status,200);assert.ok(a.fetches[0].endsWith(`orders?charge_id=${charge}`));assert.equal(a.updates,1);});
test('concurrent update without a matched record returns retry, never success',async()=>{const a=setup({race:true});assert.equal((await a.call()).status,503);});

test('invalid signature diagnostic avoids logging token, signature values, or body',async()=>{
  const b=setup();assert.equal((await b.call({alterBody:true})).status,401);
  const received=b.logs.find(([label])=>label==='Diagnóstico assinatura PagBank:')[1];
  assert.equal(received.authenticity_token_presente,true);assert.equal(received.authenticity_token_tamanho,64);
  const serialized=JSON.stringify(b.logs);assert.ok(!serialized.includes(token));assert.ok(!serialized.includes('Confirmação PIX'));
});

test('unsigned Sandbox hint can confirm only a matching PAID found via authenticated lookup',async()=>{
  const a=setup();const r=await a.call({mode:'none'});
  assert.equal(r.status,200);assert.equal(r.body.assinatura_validada,false);assert.equal(r.body.verificado_no_pagbank,true);
  assert.equal(a.updates,1);assert.equal(a.fetches.length,1);
  assert.ok(a.fetches[0].startsWith('https://sandbox.api.pagseguro.com/orders/'));
});

test('unsigned payload claiming PAID cannot override WAITING, wrong amount, or provider failure',async()=>{
  for (const opts of [{providerStatus:'WAITING'},{amount:1},{paid:1},{providerHttp:401},{missing:true}]) {
    const a=setup(opts);const r=await a.call({mode:'none'});
    assert.ok(r.status>=400);assert.equal(a.updates,0);
  }
});

test('unsigned notification cannot bypass signature enforcement outside Sandbox',async()=>{
  const a=setup({production:true});assert.equal((await a.call({mode:'none'})).status,401);
  assert.equal(a.updates,0);assert.equal(a.fetches.length,0);assert.equal(a.queries,0);
});

test('empty provided signature cannot fall back to unsigned Sandbox reconciliation',async()=>{
  const a=setup();assert.equal((await a.call({mode:'none',headers:{'x-authenticity-token':''}})).status,401);
  assert.equal(a.updates,0);assert.equal(a.fetches.length,0);
});

test('replayed unsigned notification leaves already paid record untouched',async()=>{
  const a=setup({localStatus:'PAID'});const r=await a.call({mode:'none'});
  assert.equal(r.status,200);assert.equal(r.body.duplicado,true);assert.equal(a.updates,0);
});
