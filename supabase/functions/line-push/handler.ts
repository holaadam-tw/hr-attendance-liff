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
//     platform_admin_save／platform_link_company（平台頁維護平台管理員，129 起前端不能直接寫那兩張表）、
//     company_save／company_set_status／company_delete_pending（平台頁維護公司，130 起前端不能直接寫 companies）、
//     employee_create／employee_update／employee_delete_pending、makeup_review、overtime_review、schedule_save
//     （131／132：員工管理、補卡／加班審核、排班；核准人／排班人＝LINE 驗證的 userId，不採信前端傳的員工 ID）
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

// 新動作依賴的 migration：RPC 不存在（PostgREST PGRST202）時，回報「資料庫尚未更新（1xx）」而不是籠統的服務錯誤
const RPC_MIGRATION: Record<string, string> = {
  platform_company_save: '130', platform_company_set_status: '130', platform_company_delete_pending: '130',
  review_makeup_request: '131', review_overtime_request: '131', save_schedules_verified: '131',
}

async function callRpc(deps: Deps, fn: string, args: Record<string, unknown>): Promise<{ ok: boolean; data: any; missing?: string }> {
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
    if (res.status === 404 && data && data.code === 'PGRST202') return { ok: false, data, missing: RPC_MIGRATION[fn] || '?' }
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
function rpcResult(saved: { ok: boolean; data: any; missing?: string }, extra: (d: any) => Record<string, unknown> = () => ({})): Response {
  if (saved.missing) {
    return json({ ok: false, status: 503, code: 'db_not_migrated', error: `資料庫尚未更新（${saved.missing}），請通知系統管理員` }, 503)
  }
  if (!saved.ok || !saved.data || typeof saved.data !== 'object') {
    return json({ ok: false, status: 503, code: 'service_unavailable', error: '服務暫時無法使用，請稍後再試' }, 503)
  }
  if (saved.data.success !== true) {
    const code = typeof saved.data.error_code === 'string' ? saved.data.error_code : 'failed'
    const status = ['access_denied', 'admin_only', 'role_denied', 'target_protected'].includes(code) ? 403 : 400
    return json({ ok: false, status, code, error: typeof saved.data.error === 'string' ? saved.data.error : '操作失敗' }, status)
  }
  return json({ ok: true, status: 200, ...extra(saved.data) }, 200)
}

const VERIFIED_ACTIONS = [
  'save_config', 'save_setting', 'save_settings', 'get_line_config', 'platform_admin_save', 'platform_link_company',
  // 131／132：員工管理、補卡／加班審核、排班（身分＝LINE 驗證的 userId；前端報的核准人／排班人一律不採信）
  'employee_create', 'employee_update', 'employee_delete_pending', 'makeup_review', 'overtime_review', 'schedule_save',
  // 130：平台頁的公司維護（限在職平台管理員）
  'company_save', 'company_set_status', 'company_delete_pending',
] as const
export const MAX_BATCH_SETTINGS = 30
export const MAX_BATCH_REVIEWS = 50
export const MAX_BATCH_SCHEDULES = 400

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const uuidOrNull = (v: unknown): string | null => (typeof v === 'string' && UUID_RE.test(v) ? v : null)
const withResult = (d: any) => ({ result: d })

async function handleVerifiedAction(body: any, deps: Deps): Promise<Response> {
  const action = String(body.action)
  const companyId = uuidOrNull(body.company_id)
  // company_save 的 company_id 可省略（＝新增）；有帶就必須是 UUID
  const needsCompany = action !== 'platform_admin_save' && action !== 'company_save'
  if (!body.liff_access_token || (needsCompany && !companyId)) return badRequest()
  if (action === 'company_save' && body.company_id != null && !companyId) return badRequest()
  const lineUserId = await verifyLiffAccessToken(deps, String(body.liff_access_token))
  if (!lineUserId) return unauthenticated()

  // ---- 員工管理（131：admin_* 由 DB 判斷公司、角色、公務機、受保護帳號）----
  if (action === 'employee_create') {
    if (!isObject(body.data)) return badRequest()
    return rpcResult(await callRpc(deps, 'admin_create_employee', {
      p_company_id: companyId, p_line_user_id: lineUserId, p_data: body.data,
    }), withResult)
  }
  if (action === 'employee_update') {
    const employeeId = uuidOrNull(body.employee_id)
    if (!employeeId || !isObject(body.updates)) return badRequest()
    return rpcResult(await callRpc(deps, 'admin_update_employee', {
      p_company_id: companyId, p_line_user_id: lineUserId, p_employee_id: employeeId, p_updates: body.updates,
    }), withResult)
  }
  if (action === 'employee_delete_pending') {
    const employeeId = uuidOrNull(body.employee_id)
    if (!employeeId) return badRequest()
    return rpcResult(await callRpc(deps, 'admin_delete_pending_employee', {
      p_company_id: companyId, p_line_user_id: lineUserId, p_employee_id: employeeId,
    }), withResult)
  }

  // ---- 補卡審核：可一次多筆（一鍵全批），每筆各自由 DB 驗權限與公司 ----
  if (action === 'makeup_review') {
    const decision = body.decision === 'approve' || body.decision === 'reject' ? body.decision : null
    const ids = Array.isArray(body.request_ids) ? body.request_ids : []
    if (!decision || ids.length === 0 || ids.length > MAX_BATCH_REVIEWS || ids.some((i: unknown) => !uuidOrNull(i))) return badRequest()
    const reason = typeof body.reason === 'string' ? body.reason.slice(0, 500) : null
    const review = (id: string) => callRpc(deps, 'review_makeup_request', {
      p_company_id: companyId, p_line_user_id: lineUserId, p_request_id: id, p_decision: decision, p_reason: reason,
    })
    if (ids.length === 1) return rpcResult(await review(ids[0]), withResult)
    const results: Array<Record<string, unknown>> = []
    const summary = () => ({
      results, approved_count: results.filter((x) => x.success).length,
      approved_ids: results.filter((x) => x.success).map((x) => x.id),
    })
    for (const id of ids) {
      const r = await review(id)
      if (r.missing || !r.ok || !r.data || typeof r.data !== 'object' || r.data.error_code === 'access_denied') {
        // 中途停下：回報已處理的每一筆（前端要據此計數、寫稽核），以及停在哪一筆、為什麼
        const stop = await rpcResult(r).json()
        return json({ ...stop, ...summary(), failed_id: id, not_processed_ids: ids.slice(ids.indexOf(id) + 1) }, stop.status)
      }
      results.push({
        id, success: r.data.success === true, error: r.data.success === true ? null : (r.data.error ?? null),
        closed_duplicates: r.data.closed_duplicates ?? 0,
      })
    }
    return json({ ok: true, status: 200, ...summary() }, 200)
  }

  // ---- 加班認列 ----
  if (action === 'overtime_review') {
    const decision = body.decision === 'approve' || body.decision === 'reject' ? body.decision : null
    const requestId = uuidOrNull(body.request_id)
    if (!decision || !requestId) return badRequest()
    const hours = body.approved_hours == null || body.approved_hours === '' ? null : Number(body.approved_hours)
    if (hours !== null && !Number.isFinite(hours)) return badRequest('核認時數不正確')
    return rpcResult(await callRpc(deps, 'review_overtime_request', {
      p_company_id: companyId, p_line_user_id: lineUserId, p_request_id: requestId, p_decision: decision,
      p_approved_hours: hours,
      p_reason_category: typeof body.reason_category === 'string' ? body.reason_category.slice(0, 60) : null,
      p_note: typeof body.note === 'string' ? body.note.slice(0, 500) : '',
      p_reason: typeof body.reason === 'string' ? body.reason.slice(0, 500) : null,
    }), withResult)
  }

  // ---- 排班批次儲存（整批成功或整批不存）----
  if (action === 'schedule_save') {
    const items = Array.isArray(body.items) ? body.items : []
    if (items.length === 0 || items.length > MAX_BATCH_SCHEDULES) return badRequest('排班筆數不正確')
    if (items.some((i: any) => !isObject(i) || !uuidOrNull(i.employee_id) || typeof i.date !== 'string'
      || !/^\d{4}-\d{2}-\d{2}$/.test(i.date) || (i.shift_type_id != null && !uuidOrNull(i.shift_type_id)))) {
      return badRequest('排班資料不正確')
    }
    const clean = items.map((i: any) => ({
      employee_id: i.employee_id, date: i.date, shift_type_id: i.shift_type_id ?? null,
      is_off_day: i.is_off_day === true, delete: i.delete === true,
      notes: typeof i.notes === 'string' ? i.notes.slice(0, 200) : null,
    }))
    return rpcResult(await callRpc(deps, 'save_schedules_verified', {
      p_company_id: companyId, p_line_user_id: lineUserId, p_items: clean,
    }), (d) => ({ saved_count: d.saved_count ?? 0 }))
  }

  // ---- 平台頁：公司維護（130，限在職平台管理員）----
  if (action === 'company_save') {
    if (!isObject(body.fields)) return badRequest()
    return rpcResult(await callRpc(deps, 'platform_company_save', {
      p_caller_line_user_id: lineUserId, p_company_id: companyId, p_fields: body.fields,
    }), withResult)
  }
  if (action === 'company_set_status') {
    const status = ['pending', 'active', 'suspended'].includes(body.status) ? body.status : null
    if (!status) return badRequest()
    return rpcResult(await callRpc(deps, 'platform_company_set_status', {
      p_caller_line_user_id: lineUserId, p_company_id: companyId, p_status: status,
    }), withResult)
  }
  if (action === 'company_delete_pending') {
    return rpcResult(await callRpc(deps, 'platform_company_delete_pending', {
      p_caller_line_user_id: lineUserId, p_company_id: companyId,
    }), withResult)
  }

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
