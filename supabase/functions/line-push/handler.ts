// line-push 核心邏輯（與 serve 分開，方便在 Node / Deno 直接測）
//
// 前端把 token/to/text 丟過來代推 LINE push（沿用舊介面）。
// 125 起若同時帶 company_id，會先向 DB 預約額度（line_push_reserve_frontend）：
//   - DB 會比對 token 的 SHA-256 與該公司設定是否相同，不同就不記帳（避免別人替這家公司灌用量）
//   - 超過月預算 → 不送，回 { ok:false, status:429, code:'budget_blocked' }
//   - 送出後把 LINE 的 HTTP 狀態寫回（line_push_complete），失敗不計費、看得到原因
// DB 還沒套 125（RPC 不存在）或連不上 → 照舊直接送（fail-open），不讓通知中斷。

export type Env = (key: string) => string | undefined

export interface Deps {
  fetch: typeof fetch
  env: Env
  log?: (msg: string) => void
}

export const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function recipientKind(to: string): 'user' | 'group' | 'unknown' {
  if (/^U/.test(to)) return 'user'
  if (/^[CR]/.test(to)) return 'group'
  return 'unknown'
}

function json(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

async function callRpc(deps: Deps, fn: string, args: Record<string, unknown>): Promise<{ ok: boolean; data: any }> {
  const url = deps.env('SUPABASE_URL')
  const key = deps.env('SUPABASE_SERVICE_ROLE_KEY')
  if (!url || !key) return { ok: false, data: null }
  try {
    const res = await deps.fetch(`${url}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: key, Authorization: `Bearer ${key}` },
      body: JSON.stringify(args),
    })
    const data = await res.json().catch(() => null)
    return { ok: res.ok, data }
  } catch (_) {
    return { ok: false, data: null }
  }
}

export async function handleLinePush(req: Request, deps: Deps): Promise<Response> {
  const log = deps.log || (() => {})
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }
  try {
    const body = await req.json()
    const { token, to, text } = body || {}
    if (!token || !to || !text) {
      return json({ ok: false, status: 400, error: '缺少必要參數' }, 400)
    }

    const companyId = typeof body.company_id === 'string' && UUID_RE.test(body.company_id) ? body.company_id : null
    const category = typeof body.category === 'string' && body.category ? body.category.slice(0, 60) : 'frontend_other'
    const priority = body.priority === 'high' ? 'high' : 'normal'
    const recipientRef = typeof body.recipient_ref === 'string' ? body.recipient_ref.slice(0, 60) : null

    let logId: number | null = null
    if (companyId) {
      const reserve = await callRpc(deps, 'line_push_reserve_frontend', {
        p_company_id: companyId,
        p_token_sha256: await sha256Hex(String(token)),
        p_category: category,
        p_priority: priority,
        p_recipient_kind: recipientKind(String(to)),
        p_recipient_ref: recipientRef,
      })
      if (reserve.ok && reserve.data && typeof reserve.data === 'object') {
        if (reserve.data.allowed === false) {
          return json({
            ok: false,
            status: 429,
            code: 'budget_blocked',
            error: `本月 LINE 推播預算已用完（估計 ${reserve.data.used}／上限 ${reserve.data.limit}），這則沒有送出`,
          }, 200)
        }
        if (reserve.data.allowed === true && reserve.data.log_id != null) logId = Number(reserve.data.log_id)
        if (reserve.data.reason === 'token_mismatch') log('token does not match company setting; sending without budget log')
      } else {
        log('line_push_reserve unavailable; sending without budget log')
      }
    }

    const res = await deps.fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ to, messages: [{ type: 'text', text }] }),
    })
    const raw = await res.text()
    let lineMessage = ''
    try {
      const parsed = raw ? JSON.parse(raw) : null
      lineMessage = parsed?.message || parsed?.details?.[0]?.message || ''
    } catch (_) {
      lineMessage = ''
    }

    if (logId != null) {
      await callRpc(deps, 'line_push_complete', {
        p_log_id: logId,
        p_http_status: res.status,
        p_error: res.ok ? null : (lineMessage || raw.slice(0, 300)),
      })
    }

    const payload = res.ok
      ? { ok: true, status: res.status }
      : { ok: false, status: res.status, error: lineMessage || 'LINE Messaging API 拒絕推播' }
    return json(payload, res.status)
  } catch (_) {
    return json({ ok: false, status: 500, error: 'LINE 推播服務暫時無法使用' }, 500)
  }
}
