// line-push 核心邏輯（與 serve 分開，方便在 Node / Deno 直接測）
//
// 126 起（建議模式）：前端「不帶 token」，只帶 LIFF access token：
//   1. 向 LINE 驗證 LIFF access token（/oauth2/v2.1/verify：client_id 必須是本系統的 LINE Login channel）
//      再用它取 /v2/profile 的 userId —— 身分來自 LINE，不是前端自己報的 line_user_id
//   2. 用 service role 呼叫 line_push_authorize：驗公司成員／主管、類別權限、由 DB 決定收件人、預約月預算，
//      回傳 token（只在伺服器端使用，絕不回給前端）
//   3. 送 LINE push → line_push_complete 回寫結果
//   另有幾個 action（都先驗 LIFF，身分來自 LINE，再以 service role 呼叫對應 RPC，由 DB 做權限判斷）：
//     save_config（LINE token／groupId）、save_setting／save_settings（其他公司設定，單筆／批次）、get_line_config（設定頁顯示末 4 碼）、
//     platform_admin_save／platform_link_company（平台頁維護平台管理員，129 起前端不能直接寫那兩張表）
//   員工發的訊息，DB 回傳寄件人前綴（［姓名 送出］），這裡一定加在最前面。
//
// 舊模式（相容還沒更新的頁面，前端帶 token）：必須帶 company_id，且 token 必須等於該公司設定
//   （line_push_reserve_frontend 比對 SHA-256），不符 → 403 不送（不再當任意 token 的轉發器）。
//   DB 函式暫時連不上 → 照舊送出（fail-open）。LINE_PUSH_LEGACY_TOKEN_MODE=off 可整個關掉舊模式。

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

// LIFF ID 2008962829-bnsS1bbB 的前綴就是 LINE Login channel ID；可用環境變數覆寫（逗號分隔多個）
export const DEFAULT_LINE_LOGIN_CHANNEL_IDS = ['2008962829']

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

function allowedChannelIds(env: Env): string[] {
  const raw = env('LINE_LOGIN_CHANNEL_ID')
  const list = raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : []
  return list.length ? list : DEFAULT_LINE_LOGIN_CHANNEL_IDS
}

// 向 LINE 驗證 LIFF access token，回傳真實的 LINE userId；任何一步失敗都回 null
export async function verifyLiffAccessToken(deps: Deps, accessToken: string): Promise<string | null> {
  if (!accessToken || typeof accessToken !== 'string' || accessToken.length > 2000) return null
  try {
    const v = await deps.fetch('https://api.line.me/oauth2/v2.1/verify?access_token=' + encodeURIComponent(accessToken), { method: 'GET' })
    if (!v.ok) return null
    const info = await v.json().catch(() => null)
    if (!info || !allowedChannelIds(deps.env).includes(String(info.client_id)) || !(Number(info.expires_in) > 0)) return null
    const p = await deps.fetch('https://api.line.me/v2/profile', {
      method: 'GET',
      headers: { Authorization: 'Bearer ' + accessToken },
    })
    if (!p.ok) return null
    const profile = await p.json().catch(() => null)
    const userId = profile && typeof profile.userId === 'string' ? profile.userId : ''
    return /^U[0-9a-f]{32}$/i.test(userId) ? userId : null
  } catch (_) {
    return null
  }
}

async function sendLine(deps: Deps, token: string, to: string, text: string): Promise<{ res: Response; raw: string; lineMessage: string }> {
  const res = await deps.fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
    body: JSON.stringify({ to, messages: [{ type: 'text', text: String(text).slice(0, 4900) }] }),
  })
  const raw = await res.text()
  let lineMessage = ''
  try {
    const parsed = raw ? JSON.parse(raw) : null
    lineMessage = parsed?.message || parsed?.details?.[0]?.message || ''
  } catch (_) {
    lineMessage = ''
  }
  return { res, raw, lineMessage }
}

function budgetBlocked(data: any): Response {
  return json({
    ok: false,
    status: 429,
    code: 'budget_blocked',
    error: `本月 LINE 推播預算已用完（估計 ${data?.used}／上限 ${data?.limit}），這則沒有送出`,
  }, 200)
}

const DENY_STATUS: Record<string, number> = {
  unauthenticated: 401,
  not_company_member: 403,
  manager_required: 403,
  category_not_allowed: 403,
  target_not_allowed: 403,
  rate_limited: 429,
  missing_token: 409,
  missing_group: 409,
  missing_user_line: 409,
  employee_not_found: 404,
}

const unauthenticated = () => json({ ok: false, status: 401, code: 'unauthenticated', error: 'LINE 登入已過期，請重新開啟頁面' }, 401)
const badRequest = (msg = '缺少必要參數') => json({ ok: false, status: 400, code: 'bad_request', error: msg }, 400)

// ---- 建議模式：伺服器端取 token ----
async function handleVerifiedPush(body: any, deps: Deps): Promise<Response> {
  const companyId = typeof body.company_id === 'string' && UUID_RE.test(body.company_id) ? body.company_id : null
  const text = typeof body.text === 'string' ? body.text : ''
  const target = typeof body.target === 'string' ? body.target : ''
  const category = typeof body.category === 'string' ? body.category.slice(0, 60) : ''
  const employeeId = typeof body.employee_id === 'string' && UUID_RE.test(body.employee_id) ? body.employee_id : null
  if (!companyId || !text || !target || !category || !body.liff_access_token) return badRequest()
  if (target === 'employee' && !employeeId) return badRequest('缺少收件員工')

  const lineUserId = await verifyLiffAccessToken(deps, String(body.liff_access_token))
  if (!lineUserId) return unauthenticated()

  const auth = await callRpc(deps, 'line_push_authorize', {
    p_company_id: companyId,
    p_line_user_id: lineUserId,
    p_target: target,
    p_employee_id: employeeId,
    p_category: category,
    p_priority: body.priority === 'high' ? 'high' : 'normal',
  })
  if (!auth.ok || !auth.data || typeof auth.data !== 'object') {
    // 這條路徑拿不到 token 就沒辦法送：fail-closed
    return json({ ok: false, status: 503, code: 'authorize_unavailable', error: 'LINE 推播服務暫時無法使用' }, 503)
  }
  const a = auth.data
  if (a.allowed !== true) {
    if (a.reason === 'budget_exceeded') return budgetBlocked(a)
    const reason = typeof a.reason === 'string' ? a.reason : 'forbidden'
    const status = DENY_STATUS[reason] || 403
    return json({ ok: false, status, code: reason, error: '推播未送出（' + reason + '）' }, status)
  }
  if (!a.token || !a.to) {
    return json({ ok: false, status: 503, code: 'authorize_unavailable', error: 'LINE 推播服務暫時無法使用' }, 503)
  }

  // 員工發的訊息：DB 決定的寄件人前綴一定放最前面（不能偽裝成系統／主管通知）
  const prefix = typeof a.text_prefix === 'string' ? a.text_prefix : ''
  const { res, raw, lineMessage } = await sendLine(deps, String(a.token), String(a.to), prefix + text)
  if (a.log_id != null) {
    await callRpc(deps, 'line_push_complete', {
      p_log_id: Number(a.log_id),
      p_http_status: res.status,
      p_error: res.ok ? null : (lineMessage || raw.slice(0, 300)),
    })
  }
  const payload = res.ok
    ? { ok: true, status: res.status, recipient_kind: a.recipient_kind }
    : { ok: false, status: res.status, error: lineMessage || 'LINE Messaging API 拒絕推播' }
  return json(payload, res.status)
}

// ---- 驗過 LIFF 身分後代呼叫 service-role RPC（設定寫入、LINE 設定、平台管理員）----
// RPC 回 { success:false, error_code } 時轉成 4xx；RPC 連不上 → 503
function rpcResult(saved: { ok: boolean; data: any }, extra: (d: any) => Record<string, unknown> = () => ({})): Response {
  if (!saved.ok || !saved.data || typeof saved.data !== 'object') {
    return json({ ok: false, status: 503, code: 'service_unavailable', error: '設定服務暫時無法使用' }, 503)
  }
  if (saved.data.success !== true) {
    const code = typeof saved.data.error_code === 'string' ? saved.data.error_code : 'failed'
    const status = ['access_denied', 'admin_only'].includes(code) ? 403 : 400
    return json({ ok: false, status, code, error: typeof saved.data.error === 'string' ? saved.data.error : '操作失敗' }, status)
  }
  return json({ ok: true, status: 200, ...extra(saved.data) }, 200)
}

const VERIFIED_ACTIONS = ['save_config', 'save_setting', 'save_settings', 'get_line_config', 'platform_admin_save', 'platform_link_company'] as const
export const MAX_BATCH_SETTINGS = 30

async function handleVerifiedAction(body: any, deps: Deps): Promise<Response> {
  const action = String(body.action)
  const companyId = typeof body.company_id === 'string' && UUID_RE.test(body.company_id) ? body.company_id : null
  const needsCompany = action !== 'platform_admin_save'
  if (!body.liff_access_token || (needsCompany && !companyId)) return badRequest()
  const lineUserId = await verifyLiffAccessToken(deps, String(body.liff_access_token))
  if (!lineUserId) return unauthenticated()

  if (action === 'save_config') {
    // 管理員存新 token／groupId（前端讀不到舊 token；token 留空＝沿用）
    const value: Record<string, string> = {
      groupId: typeof body.group_id === 'string' ? body.group_id.trim().slice(0, 100) : '',
    }
    if (typeof body.channel_token === 'string' && body.channel_token.trim()) value.token = body.channel_token.trim().slice(0, 1000)
    return rpcResult(await callRpc(deps, 'admin_save_setting', {
      p_company_id: companyId, p_line_user_id: lineUserId, p_key: 'line_messaging_api',
      p_value: value, p_description: 'LINE Messaging API 推播設定',
    }))
  }
  if (action === 'save_setting') {
    const key = typeof body.key === 'string' ? body.key : ''
    if (!key || key === 'line_messaging_api') return badRequest('設定名稱不正確')
    return rpcResult(await callRpc(deps, 'admin_save_setting', {
      p_company_id: companyId, p_line_user_id: lineUserId, p_key: key,
      p_value: body.value === undefined ? null : body.value,
      p_description: typeof body.description === 'string' ? body.description.slice(0, 200) : key,
    }))
  }
  if (action === 'save_settings') {
    // 一次驗證、逐筆呼叫 admin_save_setting（每筆各自驗權限）；遇到第一筆失敗就停，回報 failed_key 與已存筆數
    const items = Array.isArray(body.items) ? body.items : []
    if (items.length === 0 || items.length > MAX_BATCH_SETTINGS) return badRequest('設定筆數不正確')
    if (items.some((i: any) => !i || typeof i.key !== 'string' || !i.key || i.key === 'line_messaging_api')) return badRequest('設定名稱不正確')
    let saved = 0
    for (const i of items) {
      const r = await callRpc(deps, 'admin_save_setting', {
        p_company_id: companyId, p_line_user_id: lineUserId, p_key: i.key,
        p_value: i.value === undefined ? null : i.value,
        p_description: typeof i.description === 'string' ? i.description.slice(0, 200) : i.key,
      })
      if (!r.ok || !r.data || r.data.success !== true) {
        const res = rpcResult(r)
        const payload = await res.json()
        return json({ ...payload, failed_key: i.key, saved_count: saved }, res.status)
      }
      saved++
    }
    return json({ ok: true, status: 200, saved_count: saved }, 200)
  }
  if (action === 'get_line_config') {
    return rpcResult(await callRpc(deps, 'get_line_messaging_config', { p_company_id: companyId, p_line_user_id: lineUserId }),
      (d) => ({ has_token: d.has_token === true, token_hint: d.token_hint ?? null, group_id: d.group_id ?? '' }))
  }
  if (action === 'platform_admin_save') {
    const adminId = typeof body.admin_id === 'string' && UUID_RE.test(body.admin_id) ? body.admin_id : null
    const companyIds = Array.isArray(body.company_ids) ? body.company_ids.filter((c: unknown) => typeof c === 'string' && UUID_RE.test(c)) : []
    return rpcResult(await callRpc(deps, 'platform_admin_save', {
      p_caller_line_user_id: lineUserId, p_admin_id: adminId,
      p_line_user_id: typeof body.line_user_id === 'string' ? body.line_user_id.trim() : null,
      p_name: typeof body.name === 'string' ? body.name.slice(0, 100) : '',
      p_is_active: body.is_active !== false, p_company_ids: companyIds,
    }), (d) => ({ id: d.id }))
  }
  // platform_link_company
  return rpcResult(await callRpc(deps, 'platform_link_company_owner', { p_caller_line_user_id: lineUserId, p_company_id: companyId }))
}

// ---- 舊模式（前端帶 token）----
async function handleLegacyTokenPush(body: any, deps: Deps): Promise<Response> {
  const log = deps.log || (() => {})
  const { token, to, text } = body || {}
  if (!token || !to || !text) {
    return json({ ok: false, status: 400, error: '缺少必要參數' }, 400)
  }
  if ((deps.env('LINE_PUSH_LEGACY_TOKEN_MODE') || '').toLowerCase() === 'off') {
    return json({ ok: false, status: 410, code: 'legacy_disabled', error: '請重新整理頁面後再試' }, 410)
  }
  const companyId = typeof body.company_id === 'string' && UUID_RE.test(body.company_id) ? body.company_id : null
  if (!companyId) {
    return json({ ok: false, status: 400, code: 'company_required', error: '缺少必要參數' }, 400)
  }
  const category = typeof body.category === 'string' && body.category ? body.category.slice(0, 60) : 'frontend_other'
  const priority = body.priority === 'high' ? 'high' : 'normal'
  const recipientRef = typeof body.recipient_ref === 'string' ? body.recipient_ref.slice(0, 60) : null

  let logId: number | null = null
  const reserve = await callRpc(deps, 'line_push_reserve_frontend', {
    p_company_id: companyId,
    p_token_sha256: await sha256Hex(String(token)),
    p_category: category,
    p_priority: priority,
    p_recipient_kind: recipientKind(String(to)),
    p_recipient_ref: recipientRef,
  })
  if (reserve.ok && reserve.data && typeof reserve.data === 'object') {
    if (reserve.data.reason === 'token_mismatch') {
      log('token does not match company setting; refused')
      return json({ ok: false, status: 403, code: 'token_mismatch', error: 'LINE 設定已變更，請重新整理頁面' }, 403)
    }
    if (reserve.data.allowed === false) return budgetBlocked(reserve.data)
    if (reserve.data.allowed === true && reserve.data.log_id != null) logId = Number(reserve.data.log_id)
  } else {
    log('line_push_reserve unavailable; sending without budget log')
  }

  const { res, raw, lineMessage } = await sendLine(deps, String(token), String(to), String(text))
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
}

export async function handleLinePush(req: Request, deps: Deps): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }
  try {
    const body = await req.json()
    if (body && body.token) return await handleLegacyTokenPush(body, deps)
    if (body && (VERIFIED_ACTIONS as readonly string[]).includes(body.action)) return await handleVerifiedAction(body, deps)
    if (body && body.liff_access_token) return await handleVerifiedPush(body, deps)
    return json({ ok: false, status: 400, error: '缺少必要參數' }, 400)
  } catch (_) {
    return json({ ok: false, status: 500, error: 'LINE 推播服務暫時無法使用' }, 500)
  }
}
