import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const PAGBANK_URL = "https://sandbox.api.pagseguro.com/orders";
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function responder(status, dados) {
  if (status >= 400) {
    console.error("Erro VORTEX PIX:", { status, erro: dados.erro });
  }
  return Response.json(dados, { status, headers: corsHeaders });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") {
    return responder(405, { sucesso: false, erro: "Método não permitido" });
  }

  try {
    const token = (Deno.env.get("PAGBANK_TOKEN") || "").trim();
    const supabaseUrl = (Deno.env.get("SUPABASE_URL") || "").trim();
    const serviceRoleKey = (Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "").trim();

    if (!token || !supabaseUrl || !serviceRoleKey) {
      return responder(500, { sucesso: false, erro: "Configuração do servidor incompleta" });
    }

    const authorization = req.headers.get("Authorization") || "";
    if (!/^Bearer\s+\S+$/i.test(authorization.trim())) {
      return responder(401, { sucesso: false, erro: "Usuário não autenticado" });
    }
    const jwt = authorization.replace(/^Bearer\s+/i, "").trim();
    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: authData, error: authError } = await supabase.auth.getUser(jwt);
    if (authError || !authData?.user) {
      return responder(401, { sucesso: false, erro: "Sessão inválida ou expirada" });
    }

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return responder(400, { sucesso: false, erro: "Dados da solicitação inválidos" });
    }
    const equipamentoId = String(body.equipamento_id || "").trim();
    const codigoEquipamento = String(body.equipamento || "").trim();
    const modo = String(body.modo || "fixo").toLowerCase();
    const minutos = Number(body.minutos);
    const valorInformado = Number(body.valor);

    if (!["fixo", "minutos"].includes(modo)) {
      return responder(400, { sucesso: false, erro: "Modo de cobrança inválido" });
    }
    if (!Number.isInteger(minutos) || minutos < 1 || minutos > 120) {
      return responder(400, { sucesso: false, erro: "Informe um tempo entre 1 e 120 minutos" });
    }
    if (!Number.isFinite(valorInformado) || valorInformado <= 0 || valorInformado > 10000) {
      return responder(400, { sucesso: false, erro: "Informe um valor PIX válido" });
    }

    const { data: usuarioVortex, error: erroUsuario } = await supabase
      .from("clientes").select("id,nome,tipo_usuario,ativo")
      .eq("user_id", authData.user.id).maybeSingle();
    if (erroUsuario) {
      console.error("Erro consulta cadastro:", erroUsuario.code, erroUsuario.message);
      return responder(500, { sucesso: false, erro: "Não foi possível consultar o cadastro VORTEX" });
    }
    if (!usuarioVortex) {
      return responder(403, { sucesso: false, erro: "Cadastro VORTEX não encontrado" });
    }
    if (usuarioVortex.ativo === false) {
      return responder(403, { sucesso: false, erro: "Cadastro VORTEX inativo" });
    }

    let consultaEquipamento = supabase.from("equipamentos")
      .select("id,cliente_id,codigo,nome,preco_minuto,tempo_minutos,valor_tempo");
    if (equipamentoId) consultaEquipamento = consultaEquipamento.eq("id", equipamentoId);
    else if (codigoEquipamento) consultaEquipamento = consultaEquipamento.eq("codigo", codigoEquipamento);
    else return responder(400, { sucesso: false, erro: "Equipamento não informado" });

    const { data: equipamento, error: erroEquipamento } = await consultaEquipamento.maybeSingle();
    if (erroEquipamento) {
      console.error("Erro consulta equipamento:", erroEquipamento.code, erroEquipamento.message);
      return responder(500, { sucesso: false, erro: "Não foi possível consultar o equipamento" });
    }
    if (!equipamento) {
      return responder(404, { sucesso: false, erro: "Equipamento não encontrado" });
    }
    const ehAdmin = String(usuarioVortex.tipo_usuario || "cliente").toLowerCase() === "admin";
    if (!ehAdmin && equipamento.cliente_id !== usuarioVortex.id) {
      return responder(403, { sucesso: false, erro: "Você não possui acesso a este equipamento" });
    }
    if (!equipamento.cliente_id) {
      return responder(400, { sucesso: false, erro: "Equipamento sem cliente vinculado" });
    }

    // O preço vem do equipamento no banco, nos dois modos.
    let valorBruto;
    if (modo === "minutos") {
      const precoMinuto = Number(equipamento.preco_minuto);
      if (!Number.isFinite(precoMinuto) || precoMinuto <= 0) {
        return responder(400, { sucesso: false, erro: "Preço por minuto não configurado neste equipamento" });
      }
      valorBruto = Math.round(precoMinuto * minutos * 100) / 100;
    } else {
      const tempoFixo = Number(equipamento.tempo_minutos);
      const valorFixo = Number(equipamento.valor_tempo);
      if (!Number.isInteger(tempoFixo) || tempoFixo < 1 || tempoFixo > 120
          || !Number.isFinite(valorFixo) || valorFixo <= 0) {
        return responder(400, { sucesso: false, erro: "Valor ou tempo fixo não configurado neste equipamento" });
      }
      if (minutos !== tempoFixo) {
        return responder(400, {
          sucesso: false,
          erro: "No modo fixo, use o tempo configurado de " + tempoFixo + " minuto(s). Para outro tempo, selecione Valor por minutos.",
        });
      }
      valorBruto = Math.round(valorFixo * 100) / 100;
    }

    const valorCentavos = Math.round(valorBruto * 100);
    if (!Number.isSafeInteger(valorCentavos) || valorCentavos < 1 || valorCentavos > 1000000) {
      return responder(400, { sucesso: false, erro: "Valor calculado fora do limite permitido" });
    }
    if (Math.round(valorInformado * 100) !== valorCentavos) {
      return responder(409, {
        sucesso: false,
        erro: "O valor informado difere do preço configurado. Atualize os dados do equipamento antes de gerar o PIX.",
      });
    }

    const metadata = authData.user.user_metadata || {};
    const nomePagador = String(metadata.nome || usuarioVortex.nome || "").trim();
    const emailPagador = String(authData.user.email || "").trim();
    const documentoPagador = String(metadata.cpf_cnpj || "").replace(/\D/g, "");
    if (!nomePagador || !emailPagador || !/^(\d{11}|\d{14})$/.test(documentoPagador)) {
      return responder(400, {
        sucesso: false,
        erro: "O cadastro da conta logada precisa ter nome, e-mail e CPF/CNPJ válido para gerar o PIX.",
      });
    }

    const comissaoPercentual = 2.99;
    const comissaoCentavos = Math.round(valorCentavos * comissaoPercentual / 100);
    const comissaoVortex = comissaoCentavos / 100;
    const valorCliente = (valorCentavos - comissaoCentavos) / 100;
    const referencia = "VTX-" + Date.now() + "-" + crypto.randomUUID().replace(/-/g, "").slice(0, 8);
    const expiracao = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    const pedido = {
      reference_id: referencia,
      customer: { name: nomePagador, email: emailPagador, tax_id: documentoPagador },
      items: [{
        reference_id: equipamento.codigo,
        name: equipamento.nome || "VORTEX ASPIRADOR",
        quantity: 1,
        unit_amount: valorCentavos,
      }],
      charges: [{
        reference_id: referencia,
        description: "Uso " + equipamento.codigo + " - " + minutos + " minuto(s)",
        amount: { value: valorCentavos, currency: "BRL" },
        payment_method: { type: "PIX", pix: { expiration_date: expiracao } },
      }],
      notification_urls: [supabaseUrl + "/functions/v1/pagbank-webhook"],
    };

    const resposta = await fetch(PAGBANK_URL, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        Accept: "application/json",
        "Content-Type": "application/json",
        "x-idempotency-key": referencia,
      },
      body: JSON.stringify(pedido),
    });
    const dados = await resposta.json().catch(() => ({}));
    if (!resposta.ok) {
      console.error("Erro PagBank:", { status: resposta.status, error_messages: dados.error_messages });
      return responder(502, {
        sucesso: false,
        erro: "O PagBank não autorizou a criação do PIX",
        pagbank_status: resposta.status,
        pagbank: { error_messages: dados.error_messages || [] },
      });
    }

    const pedidoId = dados.id;
    const charge = dados.charges?.[0] || {};
    const status = String(charge.status || "WAITING").toUpperCase();
    const pixCopiaCola = charge.qr_code?.text || null;
    const qrCodeId = charge.qr_code?.id || null;
    const links = Array.isArray(charge.links) ? charge.links : [];
    const qrCodePng = links.find(link => String(link?.rel || "").toUpperCase() === "QRCODE.PNG")?.href || null;
    const qrCodeBase64 = links.find(link => String(link?.rel || "").toUpperCase() === "QRCODE.BASE64")?.href || null;

    if (!pedidoId || status === "DECLINED" || (!pixCopiaCola && !qrCodePng)) {
      console.error("Pedido sem PIX utilizável:", { pedido_id: pedidoId, status });
      return responder(502, { sucesso: false, erro: "O PagBank não retornou um QR Code PIX disponível para pagamento" });
    }

    const { error: erroPagamento } = await supabase.from("pagamentos").insert({
      cliente_id: equipamento.cliente_id,
      equipamento_id: equipamento.id,
      referencia_pagbank: pedidoId,
      valor_bruto: valorCentavos / 100,
      comissao_percentual: comissaoPercentual,
      comissao_vortex: comissaoVortex,
      valor_cliente: valorCliente,
      minutos,
      status,
    });
    if (erroPagamento) {
      console.error("PIX criado, erro banco:", { pedido_id: pedidoId, codigo: erroPagamento.code, mensagem: erroPagamento.message });
      return responder(500, {
        sucesso: false,
        erro: "PIX criado no PagBank, mas houve erro ao registrar no VORTEX. Consulte o suporte antes de gerar outra cobrança.",
        pedido_id: pedidoId,
      });
    }

    return responder(200, {
      sucesso: true,
      ambiente: "sandbox",
      equipamento: equipamento.codigo,
      equipamento_id: equipamento.id,
      modo,
      minutos,
      valor: valorCentavos,
      valor_reais: valorCentavos / 100,
      comissao_percentual: comissaoPercentual,
      comissao_vortex: comissaoVortex,
      valor_cliente: valorCliente,
      referencia,
      referencia_pagbank: pedidoId,
      pedido_id: pedidoId,
      charge_id: charge.id || null,
      qr_code_id: qrCodeId,
      pix: pixCopiaCola,
      pix_copia_cola: pixCopiaCola,
      qr_code_png: qrCodePng,
      qr_code_base64_url: qrCodeBase64,
      expiracao: charge.payment_method?.pix?.expiration_date || expiracao,
      status,
    });
  } catch (erro) {
    console.error("Erro criar PIX:", erro instanceof Error ? erro.message : String(erro));
    return responder(500, { sucesso: false, erro: "Não foi possível concluir a criação do PIX. Consulte o suporte." });
  }
});
