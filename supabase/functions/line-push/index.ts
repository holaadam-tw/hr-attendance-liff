import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }
  try {
    const { token, to, text } = await req.json()
    if (!token || !to || !text) {
      return new Response(JSON.stringify({ ok: false, status: 400, error: '缺少必要參數' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }
    const res = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ to, messages: [{ type: 'text', text }] })
    })
    const raw = await res.text()
    let lineMessage = ''
    try {
      const parsed = raw ? JSON.parse(raw) : null
      lineMessage = parsed?.message || parsed?.details?.[0]?.message || ''
    } catch (_) {
      lineMessage = ''
    }
    const payload = res.ok
      ? { ok: true, status: res.status }
      : { ok: false, status: res.status, error: lineMessage || 'LINE Messaging API 拒絕推播' }
    return new Response(JSON.stringify(payload), {
      status: res.status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  } catch (_) {
    return new Response(JSON.stringify({ ok: false, status: 500, error: 'LINE 推播服務暫時無法使用' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})
