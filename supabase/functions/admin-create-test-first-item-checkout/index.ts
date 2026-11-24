import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply({ error: "Método não permitido." }, 405);

  const url = Deno.env.get("SUPABASE_URL")!;
  const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const token = Deno.env.get("MERCADOPAGO_TEST_ACCESS_TOKEN");
  const expectedSellerId = Deno.env.get("MERCADOPAGO_TEST_SELLER_USER_ID");
  if (!token || !expectedSellerId) {
    return reply({ error: "Configure as credenciais e o ID do vendedor de teste no Supabase antes de gerar cobranças de teste." }, 503);
  }

  const auth = req.headers.get("Authorization");
  if (!auth) return reply({ error: "Faça login novamente." }, 401);
  const userClient = createClient(url, anon, { global: { headers: { Authorization: auth } } });
  const { data: { user }, error: userError } = await userClient.auth.getUser();
  if (userError || !user) return reply({ error: "Sessão inválida." }, 401);

  const { data: staff, error: staffError } = await userClient.rpc("is_staff");
  if (staffError || staff !== true) return reply({ error: "Apenas a administração pode gerar esta cobrança de teste." }, 403);

  const identityResponse = await fetch("https://api.mercadopago.com/users/me", {
    headers: { Authorization: "Bearer " + token },
  });
  if (!identityResponse.ok) return reply({ error: "Não foi possível validar a conta vendedora de teste no Mercado Pago." }, 502);
  const identity = await identityResponse.json();
  if (String(identity.id) !== String(expectedSellerId)) {
    return reply({ error: "A credencial informada não pertence à conta vendedora de teste cadastrada. Nenhuma cobrança foi criada." }, 403);
  }

  let body: { bag_id?: string; method?: string };
  try { body = await req.json(); } catch { return reply({ error: "Solicitação inválida." }, 400); }
  if (!body.bag_id || !["pix", "card"].includes(body.method || "")) {
    return reply({ error: "Informe a sacolinha de teste e escolha Pix ou cartão." }, 400);
  }

  const { data: prepared, error: prepareError } = await userClient.rpc("admin_prepare_test_first_item_payment", {
    p_bag_id: body.bag_id,
    p_method: body.method,
  });
  if (prepareError) return reply({ error: prepareError.message || "Não foi possível preparar a cobrança de teste." }, 400);
  const row = Array.isArray(prepared) ? prepared[0] : prepared;
  if (!row?.payment_id || !Number.isFinite(Number(row.amount))) {
    return reply({ error: "O banco não retornou os dados da cobrança de teste." }, 500);
  }

  const admin = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: settings } = await admin.from("payment_settings")
    .select("card_max_installments").eq("singleton", true).maybeSingle();
  const installments = body.method === "card" ? Math.max(1, Math.min(36, Number(settings?.card_max_installments || 1))) : 1;
  const excluded = body.method === "card"
    ? [{ id: "bank_transfer" }, { id: "ticket" }, { id: "debit_card" }]
    : [{ id: "credit_card" }, { id: "debit_card" }, { id: "ticket" }];

  const pref = {
    items: [
      { title: "TESTE - Primeira peça Garimpeira", quantity: 1, currency_id: "BRL", unit_price: Number(row.base_amount) },
      ...(Number(row.fee_amount) > 0 ? [{ title: "TESTE - Taxa de processamento", quantity: 1, currency_id: "BRL", unit_price: Number(row.fee_amount) }] : []),
    ],
    external_reference: String(row.payment_id),
    metadata: { payment_purpose: "first_item", bag_id: body.bag_id, payment_id: row.payment_id, environment: "test" },
    notification_url: url + "/functions/v1/mercadopago-test-webhook",
    back_urls: {
      success: "https://garimpeiradecabide.github.io/garimpeira-pdv/portal.html?mp=test-success",
      pending: "https://garimpeiradecabide.github.io/garimpeira-pdv/portal.html?mp=test-pending",
      failure: "https://garimpeiradecabide.github.io/garimpeira-pdv/portal.html?mp=test-failure",
    },
    auto_return: "approved",
    statement_descriptor: "GRP TESTE",
    payment_methods: { excluded_payment_types: excluded, installments, ...(body.method === "pix" ? { default_payment_method_id: "pix" } : {}) },
  };

  const response = await fetch("https://api.mercadopago.com/checkout/preferences", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify(pref),
  });
  const result = await response.json();
  if (!response.ok) {
    await admin.from("payments").update({ status: "failed" }).eq("id", row.payment_id).eq("status", "pending");
    return reply({ error: "O Mercado Pago não criou o checkout de teste.", details: result.message || result.error || "Falha na API." }, 502);
  }

  const checkoutUrl = result.sandbox_init_point;
  const checkoutHost = checkoutUrl ? new URL(String(checkoutUrl)).hostname : "";
  if (!checkoutUrl || !checkoutHost.startsWith("sandbox.") || !(checkoutHost.endsWith("mercadopago.com") || checkoutHost.endsWith("mercadopago.com.br"))) {
    await admin.from("payments").update({ status: "failed" }).eq("id", row.payment_id).eq("status", "pending");
    return reply({ error: "O Mercado Pago não retornou um endereço de checkout de teste seguro. Nenhum link foi liberado." }, 502);
  }

  const { error: attachError } = await userClient.rpc("admin_attach_payment_checkout", {
    p_payment_id: row.payment_id,
    p_preference_id: String(result.id),
    p_checkout_url: checkoutUrl,
  });
  if (attachError) {
    await admin.from("payments").update({ status: "failed" }).eq("id", row.payment_id).eq("status", "pending");
    return reply({ error: "Checkout de teste criado, mas não foi possível registrar o link. Atualize o painel e confira a cobrança." }, 500);
  }

  return reply({
    payment_id: row.payment_id,
    init_point: checkoutUrl,
    preference_id: result.id,
    base_amount: Number(row.base_amount),
    fee_amount: Number(row.fee_amount),
    total: Number(row.amount),
    method: body.method,
    environment: "test",
  });
});