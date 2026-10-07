import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Mesmo ambiente usado pela função criar-pix-vortex.
const API = "https://sandbox.api.pagseguro.com";
let cacheChave = null;

function resposta(status, dados) {
  if (status >= 400) console.error("Erro webhook VORTEX:", dados.erro);
  return Response.json(dados, { status });
}

function bytesBase64(valor) {
  return Uint8Array.from(atob(valor.trim()), c => c.charCodeAt(0));
}

// PagBank envia DER; Web Crypto utiliza R e S com 32 bytes cada.
function assinaturaP1363(der) {
  if (der.length < 8 || der.length > 72 || der[0] !== 48 || der[1] !== der.length - 2) {
    throw new Error("DER inválido");
  }
  const resultado = new Uint8Array(64);
  let pos = 2;
  for (let parte = 0; parte < 2; parte++) {
    if (der[pos++] !== 2) throw new Error("Inteiro DER inválido");
    const tamanho = der[pos++];
    if (!tamanho || tamanho > 33 || pos + tamanho > der.length || der[pos] & 128) {
      throw new Error("Inteiro DER inválido");
    }
    let inteiro = der.slice(pos, pos + tamanho);
    pos += tamanho;
    if (inteiro.length > 1 && inteiro[0] === 0) inteiro = inteiro.slice(1);
    if (inteiro.length > 32) throw new Error("Inteiro DER inválido");
    resultado.set(inteiro, parte * 32 + 32 - inteiro.length);
  }
  if (pos !== der.length) throw new Error("DER inválido");
  return resultado;
}

async function chaveWebhook(token, renovar = false) {
  if (!renovar && cacheChave?.token === token && Date.now() < cacheChave.expira) {
    return cacheChave.chave;
  }
  const r = await fetch(`${API}/public-keys?type=webhook`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error(`Consulta da chave PagBank falhou: HTTP ${r.status}`);
  const dados = await r.json();
  const chave = await crypto.subtle.importKey(
    "spki", bytesBase64(dados.public_key),
    { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]
  );
  cacheChave = { token, chave, expira: Date.now() + 3600000 };
  return chave;
}

async function verificarECDSA(corpo, header, chave) {
  for (const assinatura of header.split(",").slice(0, 10)) {
    try {
      if (await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" }, chave,
        assinaturaP1363(bytesBase64(assinatura)), corpo
      )) return true;
    } catch { /* Testa a próxima assinatura recebida. */ }
  }
  return false;
}

async function autenticar(req, corpo, token) {
  // Se o header novo existe, uma assinatura inválida não usa o modelo antigo.
  if (req.headers.has("x-payload-signature")) {
    const header = req.headers.get("x-payload-signature") || "";
    if (!header.trim()) return false;
    const chave = await chaveWebhook(token);
    if (await verificarECDSA(corpo, header, chave)) return true;
    return verificarECDSA(corpo, header, await chaveWebhook(token, true));
  }
  // Modelo documentado para notificações da API Order.
  const recebido = (req.headers.get("x-authenticity-token") || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(recebido)) return false;
  const prefixo = new TextEncoder().encode(`${token}-`);
  const entrada = new Uint8Array(prefixo.length + corpo.length);
  entrada.set(prefixo);
  entrada.set(corpo, prefixo.length);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", entrada));
  const esperado = Array.from(hash, b => b.toString(16).padStart(2, "0")).join("");
  let diferenca = 0;
  for (let i = 0; i < 64; i++) diferenca |= esperado.charCodeAt(i) ^ recebido.charCodeAt(i);
  return diferenca === 0;
}

Deno.serve(async req => {
  try {
    if (req.method !== "POST") return resposta(405, { erro: "Método não permitido" });
    const token = (Deno.env.get("PAGBANK_TOKEN") || "").trim();
    const url = (Deno.env.get("SUPABASE_URL") || "").trim();
    const chave = (Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "").trim();
    if (!token || !url || !chave) return resposta(500, { erro: "Configuração incompleta" });

    const corpo = new Uint8Array(await req.arrayBuffer());
    if (corpo.length > 262144) return resposta(413, { erro: "Notificação muito grande" });
    const possuiAssinatura = req.headers.has("x-payload-signature") || req.headers.has("x-authenticity-token");
    let assinaturaValidada = false;
    if (possuiAssinatura) {
      assinaturaValidada = await autenticar(req, corpo, token);
      if (!assinaturaValidada) {
        console.log("Diagnóstico assinatura PagBank:", {
          payload_signature_presente: req.headers.has("x-payload-signature"),
          payload_signature_tamanho: (req.headers.get("x-payload-signature") || "").trim().length,
          authenticity_token_presente: req.headers.has("x-authenticity-token"),
          authenticity_token_tamanho: (req.headers.get("x-authenticity-token") || "").trim().length,
        });
        return resposta(401, { erro: "Assinatura PagBank inválida" });
      }
    } else {
      // Apenas no Sandbox: o corpo é um aviso NÃO autenticado.
      // O status é sempre obtido pela consulta autenticada ao PagBank abaixo.
      if (API !== "https://sandbox.api.pagseguro.com") {
        return resposta(401, { erro: "Assinatura PagBank obrigatória fora do Sandbox" });
      }
      console.log("Sandbox: aviso sem assinatura; consultando o pedido no PagBank.");
    }
    let evento;
    try { evento = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(corpo)); }
    catch { return resposta(400, { erro: "JSON inválido" }); }

    // Aceita notificação de pedido (ORDE) ou cobrança (CHAR).
    const idEvento = String(evento?.id || "");
    if (!/^(ORDE|CHAR)_[A-Za-z0-9-]{1,100}$/.test(idEvento)) {
      return resposta(400, { erro: "ID PagBank inválido" });
    }
    const pedidoEvento = idEvento.startsWith("ORDE_");
    const endpoint = pedidoEvento
      ? `${API}/orders/${encodeURIComponent(idEvento)}`
      : `${API}/orders?charge_id=${encodeURIComponent(idEvento)}`;
    const consulta = await fetch(endpoint, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(10000),
    });
    if (!consulta.ok) return resposta(503, { erro: `Consulta do pedido falhou: HTTP ${consulta.status}` });
    const pedido = await consulta.json();
    const pedidoId = String(pedido?.id || "");
    if (!/^ORDE_[A-Za-z0-9-]{1,100}$/.test(pedidoId) || (pedidoEvento && pedidoId !== idEvento)) {
      return resposta(503, { erro: "Pedido consultado não corresponde à notificação" });
    }
    const idCobranca = pedidoEvento ? evento?.charges?.[0]?.id : idEvento;
    const cobrancas = Array.isArray(pedido.charges) ? pedido.charges : [];
    const cobranca = idCobranca
      ? cobrancas.find(c => c.id === idCobranca)
      : cobrancas.length === 1 ? cobrancas[0] : null;
    if (!cobranca || cobranca.payment_method?.type !== "PIX") {
      return resposta(503, { erro: "Cobrança PIX não localizada no pedido" });
    }
    const status = String(cobranca.status || "").toUpperCase();
    if (!["PAID", "WAITING", "DECLINED", "CANCELED", "IN_ANALYSIS", "AUTHORIZED"].includes(status)) {
      return resposta(503, { erro: "Status PagBank não reconhecido; requer revisão" });
    }
    const statusEvento = String(pedidoEvento ? evento?.charges?.[0]?.status : evento?.status).toUpperCase();
    if (statusEvento === "PAID" && status !== "PAID") {
      return resposta(503, { erro: "Pagamento ainda não confirmado na consulta PagBank" });
    }

    const supabase = createClient(url, chave, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: pagamento, error: erroBusca } = await supabase.from("pagamentos")
      .select("id,status,referencia_pagbank,valor_bruto")
      .eq("referencia_pagbank", pedidoId).maybeSingle();
    if (erroBusca) return resposta(503, { erro: "Erro ao localizar pagamento VORTEX" });
    // Não descarta a confirmação que chegou antes do INSERT em criar-pix-vortex.
    if (!pagamento) return resposta(503, { erro: "Pagamento ainda não cadastrado no VORTEX; repetir notificação" });

    const centavos = Math.round(Number(pagamento.valor_bruto) * 100);
    if (!Number.isSafeInteger(centavos) || centavos <= 0 ||
        cobranca.amount?.currency !== "BRL" || cobranca.amount?.value !== centavos) {
      return resposta(409, { erro: "Valor ou moeda não corresponde ao pagamento VORTEX" });
    }
    if (Number(cobranca.amount?.summary?.refunded || 0) > 0) {
      return resposta(409, { erro: "Pagamento com devolução exige revisão financeira" });
    }
    if (status === "PAID" && cobranca.amount?.summary?.paid != null && cobranca.amount.summary.paid !== centavos) {
      return resposta(409, { erro: "Valor confirmado não corresponde ao pagamento VORTEX" });
    }

    const statusAtual = String(pagamento.status || "").toUpperCase();
    if (statusAtual === "PAID" || statusAtual === status) {
      return resposta(200, { recebido: true, duplicado: true, assinatura_validada: assinaturaValidada, verificado_no_pagbank: true, pedido_id: pedidoId, status: statusAtual });
    }
    const atualizacao = status === "PAID"
      ? { status, pago_em: new Date().toISOString() } : { status };
    let atualiza = supabase.from("pagamentos").update(atualizacao).eq("id", pagamento.id);
    atualiza = pagamento.status == null
      ? atualiza.is("status", null) : atualiza.eq("status", pagamento.status);
    const { data: registros, error: erroAtualiza } = await atualiza.select("id,status,pago_em");
    if (erroAtualiza) return resposta(503, { erro: "Erro ao atualizar pagamento VORTEX" });
    if (registros?.length !== 1) return resposta(503, { erro: "Pagamento atualizado por outra requisição; repetir consulta" });

    // Os triggers existentes continuam responsáveis por sessão e comando.
    console.log("Webhook VORTEX confirmado:", { pedido_id: pedidoId, status });
    return resposta(200, { recebido: true, assinatura_validada: assinaturaValidada, verificado_no_pagbank: true, pedido_id: pedidoId, status });
  } catch {
    return resposta(503, { erro: "Falha ao validar ou consultar webhook PagBank" });
  }
});
