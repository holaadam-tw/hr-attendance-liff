// Supabase Edge Function: issue-amego-invoice
//
// Required secrets:
//   supabase secrets set AMEGO_INVOICE_TAX_ID=60282181
//   supabase secrets set AMEGO_APP_KEY=...
//   supabase secrets set SUPABASE_SERVICE_ROLE_KEY=...
//
// This function issues one B2C Amego invoice for a completed order.

import "https://deno.land/x/xhr@0.3.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type OrderItem = {
  name?: string;
  qty?: number | string;
  unit_price?: number | string;
  price?: number | string;
  subtotal?: number | string;
};

type OrderRecord = {
  id: string;
  store_id: string;
  order_number: string;
  customer_name?: string | null;
  customer_phone?: string | null;
  items?: OrderItem[];
  total?: number | string | null;
  status?: string;
  invoice_status?: string | null;
  invoice_number?: string | null;
  invoice_type?: string | null;
  invoice_buyer_identifier?: string | null;
  invoice_buyer_name?: string | null;
  invoice_email?: string | null;
  invoice_phone?: string | null;
  invoice_npoban?: string | null;
  invoice_retry_count?: number | null;
  store_profiles?: { company_id?: string; store_name?: string } | null;
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function money(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

function truncateText(value: unknown, max: number): string {
  return String(value || "").trim().slice(0, max);
}

function getJsonValue(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = obj[key];
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return String(value);
    }
  }
  return null;
}

function isAmegoSuccess(payload: Record<string, unknown>): boolean {
  const code = payload.code ?? payload.Code ?? payload.status ?? payload.Status;
  return String(code) === "0";
}

function settingEnabled(value: unknown): boolean {
  if (value === true || value === "true") return true;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) === true;
    } catch {
      return value === "true";
    }
  }
  return false;
}

function md5(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const bitLength = bytes.length * 8;
  const paddedLength = (((bytes.length + 8) >> 6) + 1) * 64;
  const buffer = new Uint8Array(paddedLength);
  buffer.set(bytes);
  buffer[bytes.length] = 0x80;
  const view = new DataView(buffer.buffer);
  view.setUint32(paddedLength - 8, bitLength >>> 0, true);
  view.setUint32(paddedLength - 4, Math.floor(bitLength / 0x100000000), true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;
  const shifts = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];
  const constants = Array.from({ length: 64 }, (_, i) =>
    Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0
  );
  const rotateLeft = (x: number, n: number) => ((x << n) | (x >>> (32 - n))) >>> 0;

  for (let offset = 0; offset < paddedLength; offset += 64) {
    const m = Array.from({ length: 16 }, (_, i) => view.getUint32(offset + i * 4, true));
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;

    for (let i = 0; i < 64; i++) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      const oldD = d;
      d = c;
      c = b;
      b = (b + rotateLeft((a + f + constants[i] + m[g]) >>> 0, shifts[i])) >>> 0;
      a = oldD;
    }

    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }

  return [a0, b0, c0, d0].map((word) =>
    [0, 8, 16, 24].map((shift) =>
      ((word >>> shift) & 0xff).toString(16).padStart(2, "0")
    ).join("")
  ).join("");
}

function buildAmegoData(order: OrderRecord) {
  const items = Array.isArray(order.items) ? order.items : [];
  const productItems = items.map((item, index) => {
    const qty = Math.max(Number(item.qty || 1), 1);
    const unitPrice = money(item.unit_price ?? item.price ?? 0);
    const amount = money(item.subtotal ?? unitPrice * qty);
    return {
      Description: truncateText(item.name || `Item ${index + 1}`, 256),
      Quantity: String(qty),
      UnitPrice: String(unitPrice),
      Amount: String(amount),
      Remark: "",
      TaxType: "1",
    };
  });

  if (productItems.length === 0) {
    productItems.push({
      Description: truncateText(order.store_profiles?.store_name || "餐點", 256),
      Quantity: "1",
      UnitPrice: String(money(order.total)),
      Amount: String(money(order.total)),
      Remark: "",
      TaxType: "1",
    });
  }

  const totalAmount = money(order.total || productItems.reduce((sum, item) => sum + money(item.Amount), 0));
  // Amego example separates tax from tax-included total. For restaurant retail prices,
  // the customer-facing total is tax-included, so split it into sales + 5% tax.
  const salesAmount = Math.round(totalAmount / 1.05);
  const taxAmount = totalAmount - salesAmount;
  const buyerIdentifier = truncateText(order.invoice_buyer_identifier || "", 8);
  const buyerName = truncateText(order.invoice_buyer_name || order.customer_name || "", 60);
  const phone = truncateText(order.invoice_phone || order.customer_phone || "", 26);

  const data: Record<string, unknown> = {
    OrderId: truncateText(order.order_number || order.id, 40),
    BuyerIdentifier: buyerIdentifier,
    BuyerName: buyerIdentifier ? buyerName : "",
    BuyerTelephoneNumber: phone,
    BuyerEmailAddress: truncateText(order.invoice_email || "", 80),
    NPOBAN: truncateText(order.invoice_npoban || "", 10),
    ProductItem: productItems,
    SalesAmount: String(salesAmount),
    FreeTaxSalesAmount: "0",
    ZeroTaxSalesAmount: "0",
    TaxType: "1",
    TaxRate: "0.05",
    TaxAmount: String(taxAmount),
    TotalAmount: String(totalAmount),
  };

  Object.keys(data).forEach((key) => {
    if (data[key] === "") delete data[key];
  });

  return data;
}

async function supabaseFetch(path: string, init: RequestInit = {}) {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) throw new Error("Missing Supabase service configuration");

  return await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      ...(init.headers || {}),
    },
  });
}

async function updateOrder(orderId: string, patch: Record<string, unknown>) {
  const res = await supabaseFetch(`orders?id=eq.${encodeURIComponent(orderId)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`Update order failed: ${await res.text()}`);
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ success: false, error: "method_not_allowed" }, 405);

  try {
    const appKey = Deno.env.get("AMEGO_APP_KEY");
    const taxId = Deno.env.get("AMEGO_INVOICE_TAX_ID");
    if (!appKey || !taxId) return jsonResponse({ success: false, error: "missing_amego_secrets" }, 500);

    const { order_id } = await req.json();
    if (!order_id) return jsonResponse({ success: false, error: "missing_order_id" }, 400);

    const orderRes = await supabaseFetch(
      `orders?id=eq.${encodeURIComponent(order_id)}&select=*,store_profiles!inner(company_id,store_name)&limit=1`,
      { method: "GET" },
    );
    if (!orderRes.ok) throw new Error(`Load order failed: ${await orderRes.text()}`);
    const rows = await orderRes.json();
    const order = rows?.[0] as OrderRecord | undefined;
    if (!order) return jsonResponse({ success: false, error: "order_not_found" }, 404);
    if (order.status !== "completed") return jsonResponse({ success: false, error: "order_not_completed" }, 409);
    if (order.invoice_status === "issued" && order.invoice_number) {
      return jsonResponse({ success: true, already_issued: true, invoice_number: order.invoice_number });
    }

    const companyId = order.store_profiles?.company_id;
    if (!companyId) return jsonResponse({ success: false, error: "missing_company_id" }, 500);
    const settingRes = await supabaseFetch(
      `system_settings?company_id=eq.${encodeURIComponent(companyId)}&key=eq.amego_invoice_enabled&select=value&limit=1`,
      { method: "GET" },
    );
    if (!settingRes.ok) throw new Error(`Load invoice setting failed: ${await settingRes.text()}`);
    const settings = await settingRes.json();
    if (!settingEnabled(settings?.[0]?.value)) {
      return jsonResponse({ success: false, error: "amego_invoice_disabled" }, 403);
    }

    await updateOrder(order.id, {
      invoice_status: "pending",
      invoice_error: null,
      invoice_last_attempt_at: new Date().toISOString(),
      invoice_retry_count: Number(order.invoice_retry_count || 0) + 1,
    });

    const amegoData = buildAmegoData(order);
    const dataString = JSON.stringify(amegoData);
    const time = String(Math.floor(Date.now() / 1000));
    const sign = md5(dataString + time + appKey);
    const form = new URLSearchParams({ invoice: taxId, data: dataString, time, sign });

    const amegoRes = await fetch("https://invoice-api.amego.tw/json/f0401", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    const rawText = await amegoRes.text();
    let amegoJson: Record<string, unknown>;
    try {
      amegoJson = JSON.parse(rawText);
    } catch {
      amegoJson = { code: "parse_error", raw: rawText };
    }

    if (!amegoRes.ok || !isAmegoSuccess(amegoJson)) {
      const err = getJsonValue(amegoJson, ["message", "Message", "msg", "Msg", "error", "Error"]) || rawText;
      await updateOrder(order.id, {
        invoice_status: "failed",
        invoice_error: truncateText(err, 1000),
        invoice_response: amegoJson,
        invoice_last_attempt_at: new Date().toISOString(),
      });
      return jsonResponse({ success: false, error: err, amego: amegoJson }, 502);
    }

    const invoiceNumber = getJsonValue(amegoJson, ["InvoiceNumber", "invoice_number", "InvoiceNo", "invoice_no"]);
    const invoiceDate = getJsonValue(amegoJson, ["InvoiceDate", "invoice_date", "InvoiceTime", "invoice_time"]);
    const randomCode = getJsonValue(amegoJson, ["RandomNumber", "RandomCode", "random_code", "RandomNum"]);
    await updateOrder(order.id, {
      invoice_status: "issued",
      invoice_number: invoiceNumber,
      invoice_date: invoiceDate,
      invoice_random_code: randomCode,
      invoice_response: amegoJson,
      invoice_error: null,
      invoice_issued_at: new Date().toISOString(),
      invoice_last_attempt_at: new Date().toISOString(),
    });

    return jsonResponse({ success: true, invoice_number: invoiceNumber, amego: amegoJson });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return jsonResponse({ success: false, error: message }, 500);
  }
});
