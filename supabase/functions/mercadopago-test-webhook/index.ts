import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const out = (status = 200) => new Response("ok", { status });
function hex(b: ArrayBuffer) { return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join(""); }
async function hmac(secret: string, msg: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg)));
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return out(405);
  let body: any = {};
  try { body = await req.json(); } catch { return out(400); }
  const dataId = String(body?.data?.id || new URL(req.url).searchParams.get("data.id") || "");
  if (!dataId) return out();

  // This endpoint accepts only Mercado Pago TEST notifications.
  if (body.live_mode !== false || body.type !== "payment") return out(200);

  const token = Deno.env.get("MERCADOPAGO_TEST_ACCESS_TOKEN");
  const secret = Deno.env.get("MERCADOPAGO_TEST_WEBHOOK_SECRET");
  if (!token || !secret) return out(503);

  const signature = req.headers.get("x-signature") || "";
  const requestId = req.headers.get("x-request-id") || "";
  const parts = Object.fromEntries(signature.split(",").map(s => s.trim().split("=").map(x => x.trim())));
  if (!parts.ts || !parts.v1 || !requestId) return out(401);
  const manifest = "id:" + dataId.toLowerCase() + ";request-id:" + requestId + ";ts:" + parts.ts + ";";
  const expected = await hmac(secret, manifest);
  if (expected.length !== parts.v1.length || ![...expected].every((c, i) => c === parts.v1.toLowerCase()[i])) return out(401);

  const paymentResponse = await fetch("https://api.mercadopago.com/v1/payments/" + encodeURIComponent(dataId), {
    headers: { Authorization: "Bearer " + token },
  });
  if (!paymentResponse.ok) return out(502);
  const payment = await paymentResponse.json();
  if (payment.live_mode !== false || payment.status !== "approved" || !payment.external_reference || payment.currency_id !== "BRL") return out();

  const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: internalPayment, error: lookupError } = await supa.from("payments")
    .select("id,purpose,environment").eq("id", String(payment.external_reference)).maybeSingle();
  if (lookupError) return out(500);
  if (internalPayment?.environment !== "test") return out(200);

  if (internalPayment?.purpose === "first_item" || internalPayment?.purpose === "bag_balance") {
    const rpcName = internalPayment.purpose === "first_item"
      ? "mp_confirm_first_item_payment"
      : "mp_confirm_bag_balance_payment";
    const { error } = await supa.rpc(rpcName, {
      p_payment_id: internalPayment.id,
      p_provider_payment_id: String(payment.id),
      p_amount: Number(payment.transaction_amount),
      p_payment_type_id: String(payment.payment_type_id || ""),
    });
    if (error) {
      console.error("PDV Mercado Pago TEST confirmation failed:", error.message);
      return out(409);
    }
    return out(200);
  }
  return out(200);
});