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
//     （131／132：員工管理、補卡／加班審核、排班；核准人／排班人＝LINE 驗證的 userId，不採信前端傳的員工 ID）、
//     shift_swap_review（133：換班核准／拒絕；135 起前端不能直接寫 schedules）、
//     shift_swap_create／shift_swap_respond（139：員工申請換班、對方同意／拒絕；140 起前端不能直接寫 shift_swap_requests）
//     payroll_unlock（136：薪酬密碼在 DB 以 bcrypt 比對，前端讀不到密碼）
//     kiosk_get_company／kiosk_lookup／kiosk_check_in（142）、kiosk_leave／kiosk_makeup（151）、kiosk_lunch／kiosk_lunch_status（155）
//     與 kiosk_lunch_default（156）：公務機；身分＝公務機平板登入的 LINE 帳號，
//       由 DB 確認它恰好對到 1 個在職的公務機帳號；公司一律由 DB 依公務機帳號決定，前端不帶 company_id）
//     admin_proxy_leave（153）：管理員代同公司在職、非公務機員工建立 pending 請假申請，權限與稽核姓名由 DB 驗證）
//     admin_lunch_today（154）：管理員替同公司在職、非公務機員工補訂台灣當天便當，日期與稽核姓名由 DB 決定）
//     admin_employee_sensitive（159）：已驗證的管理者讀取同公司員工的管理端敏感欄位）
//     payroll_company_get／payroll_salaries_get／salary_setting_get／salary_setting_upsert／payroll_save／leave_review
//     （161：薪資讀寫與請假核准；身分＝LINE 驗證的 userId，DB 再驗公司與管理權限）
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

export type AdminRpcValueType = 'uuid' | 'date' | 'time' | 'text' | 'integer' | 'number' | 'boolean' | 'text[]' | 'jsonb'
export interface AdminRpcParamSpec {
  type: AdminRpcValueType
  required?: boolean
  nullable?: boolean
  maxLength?: number
  maxBytes?: number
  min?: number
  max?: number
  allowed?: readonly string[]
  allowEmpty?: boolean
}
export interface AdminRpcSpec { params: Record<string, AdminRpcParamSpec> }
export interface SelfRpcSpec { signatures: AdminRpcSpec[] }

const p = (type: AdminRpcValueType, required = false, extra: Partial<AdminRpcParamSpec> = {}): AdminRpcParamSpec => ({ type, required, ...extra })

// The generic admin bridge accepts only this allowlist. Parameter names mirror
// migration 162 so the test suite can detect any SQL/Edge drift mechanically.
export const ADMIN_RPC_SPECS: Record<string, AdminRpcSpec> = {
  admin_makeup_punch: { params: { p_company_id: p('uuid'), p_employee_id: p('uuid', true), p_punch_date: p('date', true), p_punch_type: p('text', true, { maxLength: 40 }), p_punch_time: p('time', true), p_note: p('text', false, { maxLength: 1000 }) } },
  confirm_daily_overtime: { params: { p_company_id: p('uuid'), p_employee_id: p('uuid', true), p_ot_date: p('date', true), p_decision: p('text', true, { maxLength: 40 }), p_minutes: p('integer', false, { min: 0, max: 1440 }), p_note: p('text', false, { maxLength: 1000 }) } },
  create_shift_type: { params: { p_company_id: p('uuid'), p_name: p('text', true, { maxLength: 100 }), p_code: p('text', true, { maxLength: 50 }), p_start_time: p('time', true), p_end_time: p('time', true), p_is_overnight: p('boolean') } },
  delete_company_holiday: { params: { p_company_id: p('uuid'), p_holiday_date: p('date', true) } },
  delete_shift_type: { params: { p_id: p('uuid', true), p_company_id: p('uuid') } },
  get_attendance_anomalies: { params: { p_company_id: p('uuid') } },
  get_checkin_failures: { params: { p_company_id: p('uuid'), p_days: p('integer', false, { min: 1, max: 3650 }) } },
  get_company_daily_attendance: { params: { p_company_id: p('uuid'), p_date: p('date', true) } },
  get_company_holidays: { params: { p_company_id: p('uuid'), p_from: p('date', true), p_to: p('date', true) } },
  get_company_leave_requests: { params: { p_company_id: p('uuid'), p_from: p('date'), p_to: p('date'), p_statuses: p('text[]'), p_employee_id: p('uuid'), p_limit: p('integer', false, { min: 1, max: 5000 }) } },
  get_company_leave_requests_for_audit: { params: { p_company_id: p('uuid'), p_from: p('date', true), p_to: p('date', true), p_include_pending: p('boolean') } },
  get_company_monthly_attendance: { params: { p_company_id: p('uuid'), p_year: p('integer', true, { min: 2000, max: 2100 }), p_month: p('integer', true, { min: 1, max: 12 }) } },
  get_company_monthly_missing_minutes: { params: { p_company_id: p('uuid'), p_year: p('integer', true, { min: 2000, max: 2100 }), p_month: p('integer', true, { min: 1, max: 12 }) } },
  get_company_overtime_requests: { params: { p_company_id: p('uuid'), p_from: p('date'), p_to: p('date'), p_status: p('text', false, { maxLength: 40 }), p_limit: p('integer', false, { min: 1, max: 5000 }) } },
  get_company_shift_types: { params: { p_company_id: p('uuid') } },
  get_fw_trackpoints: { params: { p_trip_id: p('uuid', true) } },
  get_leave_approval_requests: { params: { p_company_id: p('uuid'), p_status: p('text', false, { maxLength: 40 }) } },
  get_leave_approval_requests_v2: { params: { p_company_id: p('uuid'), p_status: p('text', false, { maxLength: 40 }) } },
  get_line_push_status: { params: { p_company_id: p('uuid') } },
  get_makeup_review_requests: { params: { p_company_id: p('uuid'), p_status: p('text', false, { maxLength: 40 }), p_review_filter: p('text', false, { maxLength: 40 }) } },
  get_missing_work_hours_notification_control: { params: { p_company_id: p('uuid') } },
  get_pending_makeup_requests: { params: { p_company_id: p('uuid') } },
  get_pending_overtime_requests: { params: { p_company_id: p('uuid'), p_status: p('text', false, { maxLength: 40 }) } },
  get_weekly_schedules: { params: { p_company_id: p('uuid'), p_start_date: p('date', true) } },
  preview_company_missing_work_hours: { params: { p_company_id: p('uuid'), p_days_back: p('integer', false, { min: 1, max: 3650 }) } },
  resolve_attendance_anomaly: { params: { p_anomaly_id: p('uuid', true), p_company_id: p('uuid') } },
  set_missing_work_hours_notification_enabled: { params: { p_company_id: p('uuid'), p_enabled: p('boolean', true) } },
  update_shift_type: { params: { p_id: p('uuid', true), p_company_id: p('uuid'), p_name: p('text', true, { maxLength: 100 }), p_code: p('text', true, { maxLength: 50 }), p_start_time: p('time', true), p_end_time: p('time', true), p_is_overnight: p('boolean') } },
  upsert_company_holiday: { params: { p_company_id: p('uuid'), p_holiday_date: p('date', true), p_holiday_name: p('text', true, { maxLength: 200 }), p_holiday_type: p('text', false, { maxLength: 40 }) } },
}

const signature = (params: Record<string, AdminRpcParamSpec>): AdminRpcSpec => ({ params })

// Employee self-service bridge. Overloads stay explicit so SQL and Edge drift can
// be checked per signature. If any overload has p_company_id, self_rpc requires
// the payload company and therefore selects the company-scoped overload.
export const SELF_RPC_SPECS: Record<string, SelfRpcSpec> = {
  count_fw_trackpoints: { signatures: [signature({ p_trip_id: p('uuid', true) })] },
  get_company_leave_overlap: { signatures: [signature({
    p_company_id: p('uuid', true), p_from: p('date', true), p_to: p('date', true),
  })] },
  get_employee_schedule: { signatures: [signature({
    p_year: p('integer', true, { min: 2000, max: 2100 }), p_month: p('integer', true, { min: 1, max: 12 }),
  })] },
  get_leave_history: { signatures: [
    signature({ p_company_id: p('uuid', true), p_limit: p('integer', false, { min: 1, max: 100 }) }),
    signature({ p_limit: p('integer', false, { min: 1, max: 100 }) }),
  ] },
  get_monthly_attendance: { signatures: [signature({
    p_year: p('integer', true, { min: 2000, max: 2100 }), p_month: p('integer', true, { min: 1, max: 12 }),
  })] },
  get_my_current_salary: { signatures: [signature({})] },
  get_my_leave_requests: { signatures: [signature({
    p_company_id: p('uuid', true), p_from: p('date'), p_to: p('date'), p_statuses: p('text[]'),
    p_limit: p('integer', false, { min: 1, max: 1000 }),
  })] },
  get_my_overtime_requests: { signatures: [signature({ p_limit: p('integer', false, { min: 1, max: 100 }) })] },
  get_my_payslip: { signatures: [signature({
    p_year: p('integer', true, { min: 2000, max: 2100 }), p_month: p('integer', true, { min: 1, max: 12 }),
  })] },
  get_my_year_end_stats: { signatures: [signature({ p_year: p('integer', true, { min: 2000, max: 2100 }) })] },
  insert_fw_trackpoints: { signatures: [signature({
    p_trip_id: p('uuid', true), p_points: p('jsonb', true, { maxBytes: 65536 }),
  })] },
  register_employee: { signatures: [signature({
    p_company_id: p('uuid', true), p_data: p('jsonb', true, { maxBytes: 16384 }),
  })] },
  set_my_preferred_language: { signatures: [signature({
    p_company_id: p('uuid', true), p_language: p('text', true, { maxLength: 10, allowed: ['zh-TW', 'vi-VN'] }),
  })] },
  submit_leave_request: { signatures: [
    signature({
      p_company_id: p('uuid', true),
      p_leave_type: p('text', true, { maxLength: 40, allowed: ['annual', 'sick', 'personal', 'compensatory', 'bereavement'] }),
      p_start_date: p('date', true), p_end_date: p('date', true), p_reason: p('text', true, { maxLength: 2000 }),
      p_leave_period: p('text', true, { maxLength: 20, allowed: ['full_day', 'am', 'pm', 'hourly'] }),
      p_leave_start_time: p('time', true, { nullable: true }), p_leave_end_time: p('time', true, { nullable: true }),
    }),
    signature({
      p_leave_type: p('text', true, { maxLength: 40, allowed: ['annual', 'sick', 'personal', 'compensatory', 'bereavement'] }),
      p_start_date: p('date', true), p_end_date: p('date', true), p_reason: p('text', true, { maxLength: 2000 }),
      p_leave_period: p('text', false, { maxLength: 20, allowed: ['full_day', 'am', 'pm'] }),
      p_leave_hours: p('number', false, { nullable: true, min: 0.01, max: 24 }),
    }),
  ] },
  submit_overtime_request: { signatures: [signature({
    p_ot_date: p('date', true), p_hours: p('number', true, { min: 0.01, max: 12 }),
    p_reason: p('text', true, { maxLength: 2000, allowEmpty: true }),
    p_compensation_type: p('text', false, { maxLength: 40, allowed: ['pay', 'comp_leave'] }),
  })] },
}

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
  review_shift_swap_request: '133',
  shift_swap_request_create: '139', shift_swap_request_respond: '139',
  payroll_password_unlock: '136',
  kiosk_get_company_verified: '142', kiosk_lookup_employee_verified: '142', kiosk_check_in_verified: '142',
  kiosk_submit_leave_verified: '151', kiosk_submit_makeup_verified: '151',
  kiosk_lunch_today_verified: '155', kiosk_lunch_today_status_verified: '155',
  kiosk_lunch_apply_default_verified: '156',
  admin_submit_leave_for_employee_verified: '153',
  admin_order_lunch_today_verified: '154',
  admin_get_employee_sensitive_verified: '159',
  get_company_payroll_verified: '161', get_company_current_salaries_verified: '161',
  get_employee_current_salary_verified: '161', upsert_salary_setting_verified: '161',
  save_payroll_records_verified: '161', approve_leave_request_verified: '161',
  ...Object.fromEntries(Object.keys(ADMIN_RPC_SPECS).map((fn) => [`${fn}_verified`, '162'])),
  ...Object.fromEntries(Object.keys(SELF_RPC_SPECS).map((fn) => [`${fn}_verified`, '163'])),
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

// JSONB 讀取 RPC 可能合法回 array／object／null，不能套只接受 {success:true} 的 rpcResult。
function rpcValueResult(saved: { ok: boolean; data: any; missing?: string }): Response {
  if (saved.missing) {
    return json({ ok: false, status: 503, code: 'db_not_migrated', error: `資料庫尚未更新（${saved.missing}），請通知系統管理員` }, 503)
  }
  if (!saved.ok) {
    const message = typeof saved.data?.message === 'string' ? saved.data.message : ''
    const denied = /管理員權限|無權存取|access_denied/i.test(message)
    return json({
      ok: false,
      status: denied ? 403 : 503,
      code: denied ? 'access_denied' : 'service_unavailable',
      error: denied ? '需要管理員權限' : '服務暫時無法使用，請稍後再試',
    }, denied ? 403 : 503)
  }
  return json({ ok: true, status: 200, result: saved.data ?? null }, 200)
}

function adminRpcResult(saved: { ok: boolean; data: any; missing?: string }): Response {
  if (saved.missing) {
    return json({ ok: false, status: 503, code: 'db_not_migrated', error: `資料庫尚未套用 migration ${saved.missing}` }, 503)
  }
  if (!saved.ok) {
    const message = typeof saved.data?.message === 'string' && saved.data.message
      ? saved.data.message
      : '管理功能暫時無法使用'
    const dbCode = typeof saved.data?.code === 'string' && saved.data.code ? saved.data.code : null
    const denied = dbCode === '42501' || /access_denied|permission denied|無權限/i.test(message)
    const unavailable = saved.data == null
    return json({
      ok: false,
      status: unavailable ? 503 : (denied ? 403 : 400),
      code: dbCode || (unavailable ? 'service_unavailable' : (denied ? 'access_denied' : 'rpc_failed')),
      error: message,
    }, unavailable ? 503 : (denied ? 403 : 400))
  }
  return json({ ok: true, status: 200, result: saved.data ?? null }, 200)
}

function selfRpcResult(saved: { ok: boolean; data: any; missing?: string }): Response {
  if (saved.missing) {
    return json({ ok: false, status: 503, code: 'db_not_migrated', error: `資料庫尚未套用 migration ${saved.missing}` }, 503)
  }
  if (!saved.ok) {
    const message = typeof saved.data?.message === 'string' && saved.data.message
      ? saved.data.message
      : '員工功能暫時無法使用'
    const dbCode = typeof saved.data?.code === 'string' && saved.data.code ? saved.data.code : null
    const denied = dbCode === '42501' || /access_denied|permission denied|無權限/i.test(message)
    const unavailable = saved.data == null
    return json({
      ok: false,
      status: unavailable ? 503 : (denied ? 403 : 400),
      code: dbCode || (unavailable ? 'service_unavailable' : (denied ? 'access_denied' : 'rpc_failed')),
      error: message,
    }, unavailable ? 503 : (denied ? 403 : 400))
  }
  return json({ ok: true, status: 200, result: saved.data ?? null }, 200)
}

const VERIFIED_ACTIONS = [
  'save_config', 'save_setting', 'save_settings', 'get_line_config', 'platform_admin_save', 'platform_link_company',
  // 131／132：員工管理、補卡／加班審核、排班（身分＝LINE 驗證的 userId；前端報的核准人／排班人一律不採信）
  'employee_create', 'employee_update', 'employee_delete_pending', 'makeup_review', 'overtime_review', 'schedule_save',
  // 130：平台頁的公司維護（限在職平台管理員）
  'company_save', 'company_set_status', 'company_delete_pending',
  // 133：換班審核（審核人＝LINE 驗證的 userId；核准時同一交易互換班別）
  'shift_swap_review',
  // 139：員工端換班（申請人／回覆人＝LINE 驗證的 userId；前端報的員工 ID 一律不採信）
  'shift_swap_create', 'shift_swap_respond',
  // 136：薪酬密碼改在伺服器端比對（DB 只存 bcrypt 雜湊），成功回短效 unlock_token
  'payroll_unlock',
  // 142：公務機（身分＝平板登入的公務機 LINE 帳號；前端報的 kiosk LINE ID 一律不採信）
  'kiosk_get_company', 'kiosk_lookup', 'kiosk_check_in', 'kiosk_leave', 'kiosk_makeup', 'kiosk_lunch', 'kiosk_lunch_status', 'kiosk_lunch_default',
  // 153：管理員代員工請假（公司必填；不可歸類為公務機動作）
  'admin_proxy_leave',
  // 154：管理員補訂當天便當（公司必填；日期只由 DB 決定）
  'admin_lunch_today',
  // 159：管理端員工敏感欄位（公司必填；非公務機動作）
  'admin_employee_sensitive',
  // 161：薪資讀寫與請假核准（公司必填；LINE 驗出的 userId 由 DB 再驗權）
  'payroll_company_get', 'payroll_salaries_get', 'salary_setting_get',
  'salary_setting_upsert', 'payroll_save', 'leave_review',
  'admin_rpc', 'self_rpc',
] as const
const KIOSK_ACTIONS: readonly string[] = ['kiosk_get_company', 'kiosk_lookup', 'kiosk_check_in', 'kiosk_leave', 'kiosk_makeup', 'kiosk_lunch', 'kiosk_lunch_status', 'kiosk_lunch_default']
export const MAX_BATCH_SETTINGS = 30
export const MAX_BATCH_REVIEWS = 50
export const MAX_BATCH_SCHEDULES = 400
export const MAX_PAYROLL_RECORDS = 500
export const MAX_PAYROLL_JSON_BYTES = 1024 * 1024

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const uuidOrNull = (v: unknown): string | null => (typeof v === 'string' && UUID_RE.test(v) ? v : null)
const withResult = (d: any) => ({ result: d })
const VERIFIED_LEAVE_TYPES = new Set(['annual', 'sick', 'personal', 'compensatory', 'bereavement'])  // 與員工自助 records.html 選項一致
const VERIFIED_LEAVE_PERIODS = new Set(['full_day', 'am', 'pm', 'hourly'])
const TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/
const onlyKeys = (body: Record<string, unknown>, allowed: string[]) => Object.keys(body).every((k) => allowed.includes(k))
const intInRange = (v: unknown, min: number, max: number): v is number => Number.isInteger(v) && Number(v) >= min && Number(v) <= max
const numberInRange = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max

const PAYROLL_RECORD_KEYS = [
  'employee_id', 'year', 'month', 'salary_type', 'base_salary', 'overtime_pay', 'bonus',
  'full_attendance_bonus', 'meal_allowance', 'position_allowance', 'night_allowance',
  'late_deduction', 'absence_deduction', 'personal_leave_deduction', 'labor_insurance',
  'health_insurance', 'pension_self', 'income_tax', 'manual_adjustment', 'adjustment_note',
  'total_deduction', 'gross_salary', 'net_salary', 'calculation_details', 'is_published', 'updated_at',
]
const PAYROLL_NUMERIC_KEYS = [
  'base_salary', 'overtime_pay', 'bonus', 'full_attendance_bonus', 'meal_allowance',
  'position_allowance', 'night_allowance', 'late_deduction', 'absence_deduction',
  'personal_leave_deduction', 'labor_insurance', 'health_insurance', 'pension_self',
  'income_tax', 'manual_adjustment', 'total_deduction', 'gross_salary', 'net_salary',
]

function validPayrollRecord(record: unknown, year: number, month: number): record is Record<string, unknown> {
  if (!isObject(record) || !onlyKeys(record, PAYROLL_RECORD_KEYS) || !uuidOrNull(record.employee_id)) return false
  if (record.salary_type !== 'monthly' && record.salary_type !== 'daily' && record.salary_type !== 'hourly') return false
  if (record.year !== year || record.month !== month || typeof record.is_published !== 'boolean') return false
  if (typeof record.updated_at !== 'string' || record.updated_at.length > 40 || Number.isNaN(Date.parse(record.updated_at))) return false
  if (PAYROLL_NUMERIC_KEYS.some((key) => !numberInRange(record[key], -100000000, 100000000))) return false
  if (Number(record.base_salary) < 0) return false
  if (record.adjustment_note != null && (typeof record.adjustment_note !== 'string' || record.adjustment_note.length > 1000)) return false
  if (record.calculation_details != null && typeof record.calculation_details !== 'object') return false
  return true
}

// YYYY-MM-DD 且是真的日期（2026-02-30 這種交給 DB 會變成 503，這裡先回 400）
export function isRealDate(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false
  const d = new Date(v + 'T00:00:00Z')
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v
}

export function validateAdminRpcValue(value: unknown, spec: AdminRpcParamSpec): boolean {
  if (value == null) return spec.nullable === true || spec.required !== true
  switch (spec.type) {
    case 'uuid':
      return typeof value === 'string' && UUID_RE.test(value)
    case 'date':
      return isRealDate(value)
    case 'time':
      return typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,6})?)?$/.test(value)
    case 'text':
      return typeof value === 'string' && value.length <= (spec.maxLength ?? 2000)
        && (!spec.required || spec.allowEmpty || value.length > 0) && (!spec.allowed || spec.allowed.includes(value))
    case 'integer':
      return Number.isInteger(value) && Number(value) >= (spec.min ?? -1000000000) && Number(value) <= (spec.max ?? 1000000000)
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
        && value >= (spec.min ?? -1000000000) && value <= (spec.max ?? 1000000000)
    case 'boolean':
      return typeof value === 'boolean'
    case 'text[]':
      return Array.isArray(value) && value.length <= 100 && value.every((item) => typeof item === 'string' && item.length <= 100)
    case 'jsonb':
      if (typeof value !== 'object') return false
      try {
        return new TextEncoder().encode(JSON.stringify(value)).byteLength <= (spec.maxBytes ?? 65536)
      } catch (_) {
        return false
      }
  }
}

async function handleVerifiedAction(body: any, deps: Deps): Promise<Response> {
  const action = String(body.action)
  const companyId = uuidOrNull(body.company_id)
  const selfFn = action === 'self_rpc' && typeof body.fn === 'string' ? body.fn : ''
  const selfSpec = action === 'self_rpc' && Object.prototype.hasOwnProperty.call(SELF_RPC_SPECS, selfFn)
    ? SELF_RPC_SPECS[selfFn]
    : undefined
  const selfNeedsCompany = !!selfSpec?.signatures.some((item) => Object.prototype.hasOwnProperty.call(item.params, 'p_company_id'))
  // company_save 的 company_id 可省略（＝新增）；有帶就必須是 UUID
  // 公務機動作的公司由 DB 依公務機帳號決定，不帶 company_id
  // self_rpc 只在函式簽章含 p_company_id 時要求 company；其他 action 維持原判斷。
  const needsCompany = action === 'self_rpc'
    ? selfNeedsCompany
    : action !== 'platform_admin_save' && action !== 'company_save' && !KIOSK_ACTIONS.includes(action)
  if (!body.liff_access_token || (needsCompany && !companyId)) return badRequest()
  if (action === 'company_save' && body.company_id != null && !companyId) return badRequest()
  if (action === 'self_rpc' && body.company_id != null && !companyId) return badRequest('公司識別格式錯誤')
  const lineUserId = await verifyLiffAccessToken(deps, String(body.liff_access_token))
  if (!lineUserId) return unauthenticated()

  // ---- 161：薪資讀寫與請假核准。所有 action 嚴格白名單，身分只採 LINE 驗證結果。 ----
  if (action === 'admin_rpc') {
    if (!onlyKeys(body, ['action', 'liff_access_token', 'company_id', 'fn', 'args']) || !isObject(body.args)) {
      return badRequest('管理 RPC 請求格式錯誤')
    }
    const fn = typeof body.fn === 'string' ? body.fn : ''
    const spec = Object.prototype.hasOwnProperty.call(ADMIN_RPC_SPECS, fn) ? ADMIN_RPC_SPECS[fn] : undefined
    if (!spec) return badRequest('不允許的管理 RPC')
    if ('p_line_user_id' in body.args) return badRequest('呼叫端不得指定 LINE 身分')
    if (Object.keys(body.args).some((key) => !Object.prototype.hasOwnProperty.call(spec.params, key))) return badRequest('管理 RPC 含未知參數')
    if (body.args.p_company_id != null && body.args.p_company_id !== companyId) return badRequest('公司識別不一致')

    const rpcArgs: Record<string, unknown> = { p_line_user_id: lineUserId }
    for (const [name, paramSpec] of Object.entries(spec.params)) {
      const value = name === 'p_company_id' ? companyId : body.args[name]
      if (!validateAdminRpcValue(value, paramSpec)) return badRequest(`管理 RPC 參數錯誤：${name}`)
      if (value !== undefined) rpcArgs[name] = value
    }
    return adminRpcResult(await callRpc(deps, `${fn}_verified`, rpcArgs))
  }

  if (action === 'self_rpc') {
    if (!onlyKeys(body, ['action', 'liff_access_token', 'company_id', 'fn', 'args']) || !isObject(body.args)) {
      return badRequest('員工 RPC 請求格式錯誤')
    }
    const fn = typeof body.fn === 'string' ? body.fn : ''
    const spec = Object.prototype.hasOwnProperty.call(SELF_RPC_SPECS, fn) ? SELF_RPC_SPECS[fn] : undefined
    if (!spec) return badRequest('不允許的員工 RPC')
    if (Object.prototype.hasOwnProperty.call(body.args, 'p_line_user_id')) return badRequest('呼叫端不得指定 LINE 身分')
    if (Object.prototype.hasOwnProperty.call(body.args, 'p_company_id') && body.args.p_company_id !== companyId) {
      return badRequest('公司識別不一致')
    }

    const matches = spec.signatures.filter((candidate) => {
      const candidateHasCompany = Object.prototype.hasOwnProperty.call(candidate.params, 'p_company_id')
      if (selfNeedsCompany && !candidateHasCompany) return false
      if (Object.keys(body.args).some((key) => !Object.prototype.hasOwnProperty.call(candidate.params, key))) return false
      for (const [name, paramSpec] of Object.entries(candidate.params)) {
        const hasValue = name === 'p_company_id'
          ? companyId !== null
          : Object.prototype.hasOwnProperty.call(body.args, name)
        if (!hasValue) {
          if (paramSpec.required) return false
          continue
        }
        const value = name === 'p_company_id' ? companyId : body.args[name]
        if (!validateAdminRpcValue(value, paramSpec)) return false
      }
      return true
    })
    if (matches.length !== 1) return badRequest('員工 RPC 參數不符合允許簽章')

    const rpcArgs: Record<string, unknown> = { p_line_user_id: lineUserId }
    for (const name of Object.keys(matches[0].params)) {
      if (name === 'p_company_id') {
        rpcArgs[name] = companyId
      } else if (Object.prototype.hasOwnProperty.call(body.args, name)) {
        rpcArgs[name] = body.args[name]
      }
    }
    return selfRpcResult(await callRpc(deps, `${fn}_verified`, rpcArgs))
  }

  if (action === 'payroll_company_get') {
    const allowed = ['action', 'liff_access_token', 'company_id', 'year', 'month']
    if (!onlyKeys(body, allowed) || !intInRange(body.year, 2000, 2100) || !intInRange(body.month, 1, 12)) return badRequest('薪資年月不正確')
    return rpcValueResult(await callRpc(deps, 'get_company_payroll_verified', {
      p_line_user_id: lineUserId, p_company_id: companyId, p_year: body.year, p_month: body.month,
    }))
  }

  if (action === 'payroll_salaries_get') {
    const allowed = ['action', 'liff_access_token', 'company_id']
    if (!onlyKeys(body, allowed)) return badRequest('薪資查詢資料不正確')
    return rpcValueResult(await callRpc(deps, 'get_company_current_salaries_verified', {
      p_line_user_id: lineUserId, p_company_id: companyId,
    }))
  }

  if (action === 'salary_setting_get') {
    const allowed = ['action', 'liff_access_token', 'company_id', 'employee_id']
    const employeeId = uuidOrNull(body.employee_id)
    if (!onlyKeys(body, allowed) || !employeeId) return badRequest('員工資料不正確')
    return rpcValueResult(await callRpc(deps, 'get_employee_current_salary_verified', {
      p_line_user_id: lineUserId, p_company_id: companyId, p_employee_id: employeeId,
    }))
  }

  if (action === 'salary_setting_upsert') {
    const allowed = ['action', 'liff_access_token', 'company_id', 'employee_id', 'salary_type', 'base_salary',
      'meal_allowance', 'position_allowance', 'full_attendance_bonus', 'pension_self_rate', 'sync_employee_rate']
    const employeeId = uuidOrNull(body.employee_id)
    const salaryType = body.salary_type === 'monthly' || body.salary_type === 'daily' || body.salary_type === 'hourly' ? body.salary_type : null
    const allowances = [body.meal_allowance, body.position_allowance, body.full_attendance_bonus]
    if (!onlyKeys(body, allowed) || !employeeId || !salaryType
      || !numberInRange(body.base_salary, 0.01, 100000000)
      || allowances.some((v) => !numberInRange(v, 0, 100000000))
      || !numberInRange(body.pension_self_rate, 0, 100)
      || typeof body.sync_employee_rate !== 'boolean') return badRequest('薪資設定資料不正確')
    return rpcResult(await callRpc(deps, 'upsert_salary_setting_verified', {
      p_line_user_id: lineUserId, p_company_id: companyId, p_employee_id: employeeId,
      p_salary_type: salaryType, p_base_salary: body.base_salary,
      p_meal_allowance: body.meal_allowance, p_position_allowance: body.position_allowance,
      p_full_attendance_bonus: body.full_attendance_bonus, p_pension_self_rate: body.pension_self_rate,
      p_sync_employee_rate: body.sync_employee_rate,
    }), withResult)
  }

  if (action === 'payroll_save') {
    const allowed = ['action', 'liff_access_token', 'company_id', 'year', 'month', 'records', 'is_published']
    const records = Array.isArray(body.records) ? body.records : null
    let bytes = Number.POSITIVE_INFINITY
    try { bytes = records ? new TextEncoder().encode(JSON.stringify(records)).length : Number.POSITIVE_INFINITY } catch (_) { /* bad request */ }
    if (!onlyKeys(body, allowed) || !intInRange(body.year, 2000, 2100) || !intInRange(body.month, 1, 12)
      || !records || records.length === 0 || records.length > MAX_PAYROLL_RECORDS
      || bytes > MAX_PAYROLL_JSON_BYTES || typeof body.is_published !== 'boolean'
      || records.some((record) => !validPayrollRecord(record, body.year, body.month))) return badRequest('薪資資料不正確')
    return rpcResult(await callRpc(deps, 'save_payroll_records_verified', {
      p_line_user_id: lineUserId, p_company_id: companyId, p_year: body.year, p_month: body.month,
      p_records: records, p_is_published: body.is_published,
    }), withResult)
  }

  if (action === 'leave_review') {
    const allowed = ['action', 'liff_access_token', 'company_id', 'request_id', 'status', 'rejection_reason']
    const requestId = uuidOrNull(body.request_id)
    const status = body.status === 'approved' || body.status === 'rejected' ? body.status : null
    const reason = body.rejection_reason == null ? null : (typeof body.rejection_reason === 'string' ? body.rejection_reason.trim() : false)
    if (!onlyKeys(body, allowed) || !requestId || !status || reason === false || (typeof reason === 'string' && reason.length > 500)) return badRequest('請假審核資料不正確')
    return rpcResult(await callRpc(deps, 'approve_leave_request_verified', {
      p_line_user_id: lineUserId, p_company_id: companyId, p_request_id: requestId,
      p_status: status, p_rejection_reason: status === 'rejected' ? (reason || '不符合規定') : null,
    }), withResult)
  }

  // ---- 管理端員工敏感欄位（159）：身分＝LINE 驗證的 userId；DB 再驗管理權與公司 ----
  if (action === 'admin_employee_sensitive') {
    const allowed = ['action', 'liff_access_token', 'company_id', 'employee_ids']
    const hasEmployeeIds = body.employee_ids != null
    const employeeIds = Array.isArray(body.employee_ids)
      && body.employee_ids.length <= 500
      && body.employee_ids.every((id: unknown) => uuidOrNull(id) !== null)
      ? body.employee_ids
      : null
    if (!onlyKeys(body, allowed) || (hasEmployeeIds && employeeIds === null)) return badRequest('員工清單不正確')
    return rpcResult(await callRpc(deps, 'admin_get_employee_sensitive_verified', {
      p_line_user_id: lineUserId, p_company_id: companyId, p_employee_ids: employeeIds,
    }), withResult)
  }

  // ---- 管理員補訂當天便當（154）：身分＝LINE 驗證的 userId；DB 決定台灣日期並再驗公司與員工 ----
  if (action === 'admin_lunch_today') {
    const allowed = ['action', 'liff_access_token', 'company_id', 'employee_id', 'choice']
    const employeeId = uuidOrNull(body.employee_id)
    const choice = body.choice === 'regular' || body.choice === 'vegetarian' || body.choice === 'none' ? body.choice : null
    if (!onlyKeys(body, allowed) || !employeeId || !choice) return badRequest('便當資料不正確')
    return rpcResult(await callRpc(deps, 'admin_order_lunch_today_verified', {
      p_company_id: companyId, p_line_user_id: lineUserId, p_employee_id: employeeId, p_choice: choice,
    }), withResult)
  }

  // ---- 管理員代請假（153）：身分＝LINE 驗證的 userId；DB 再驗公司權限與目標員工 ----
  if (action === 'admin_proxy_leave') {
    const allowed = ['action', 'liff_access_token', 'company_id', 'employee_id', 'leave_type', 'start_date', 'end_date', 'reason', 'leave_period', 'leave_start_time', 'leave_end_time']
    const employeeId = uuidOrNull(body.employee_id)
    const leaveType = typeof body.leave_type === 'string' && VERIFIED_LEAVE_TYPES.has(body.leave_type) ? body.leave_type : null
    const period = typeof body.leave_period === 'string' && VERIFIED_LEAVE_PERIODS.has(body.leave_period) ? body.leave_period : null
    const start = isRealDate(body.start_date) ? body.start_date : null
    const end = isRealDate(body.end_date) ? body.end_date : null
    const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
    const startTime = typeof body.leave_start_time === 'string' && TIME_RE.test(body.leave_start_time) ? body.leave_start_time : null
    const endTime = typeof body.leave_end_time === 'string' && TIME_RE.test(body.leave_end_time) ? body.leave_end_time : null
    if (!onlyKeys(body, allowed) || !employeeId || !leaveType || !period || !start || !end || end < start || !reason || reason.length > 1000) return badRequest('請假資料不正確')
    if ((period !== 'full_day' && start !== end) || (period === 'hourly' && (!startTime || !endTime || endTime <= startTime)))
      return badRequest('請假時段不正確')
    if (period !== 'hourly' && (body.leave_start_time != null || body.leave_end_time != null)) return badRequest('請假時段不正確')
    return rpcResult(await callRpc(deps, 'admin_submit_leave_for_employee_verified', {
      p_company_id: companyId, p_line_user_id: lineUserId, p_employee_id: employeeId, p_leave_type: leaveType,
      p_start_date: start, p_end_date: end, p_reason: reason, p_leave_period: period,
      p_leave_start_time: period === 'hourly' ? startTime : null, p_leave_end_time: period === 'hourly' ? endTime : null,
    }), withResult)
  }

  // ---- 薪酬密碼（136）：比對在 DB（bcrypt），錯誤次數限制也在 DB；密碼不記 log、不回傳 ----
  if (action === 'payroll_unlock') {
    const password = typeof body.password === 'string' ? body.password : ''
    // bcrypt 只看前 72 bytes（DB 端同樣檢查）
    if (!password || new TextEncoder().encode(password).length > 72) return badRequest('請輸入密碼（最多 72 bytes）')
    const r = await callRpc(deps, 'payroll_password_unlock', {
      p_company_id: companyId, p_line_user_id: lineUserId, p_password: password,
    })
    if (r.ok && r.data && typeof r.data === 'object' && r.data.success !== true) {
      if (r.data.error_code === 'wrong_password') return json({ ok: false, status: 403, code: 'wrong_password', error: '密碼錯誤' }, 403)
      if (r.data.error_code === 'rate_limited') {
        return json({ ok: false, status: 429, code: 'rate_limited', error: typeof r.data.error === 'string' ? r.data.error : '嘗試次數太多，請稍後再試' }, 429)
      }
    }
    return rpcResult(r, (d) => ({
      unlock_token: typeof d.unlock_token === 'string' ? d.unlock_token : null,
      expires_at: d.expires_at ?? null,
      configured: d.configured === true,
    }))
  }

  // ---- 公務機（142）：身分＝LINE 驗證的公務機帳號 userId；公司由 DB 決定 ----
  if (action === 'kiosk_get_company') {
    return rpcResult(await callRpc(deps, 'kiosk_get_company_verified', { p_line_user_id: lineUserId }),
      (d) => ({ result: { success: true, name: typeof d.name === 'string' ? d.name : '', company_id: d.company_id ?? null } }))
  }
  if (action === 'kiosk_lookup') {
    const identifier = typeof body.identifier === 'string' ? body.identifier.trim() : ''
    if (!identifier || identifier.length > 32) return badRequest('請輸入工號、手機或身分證後4碼')
    return rpcResult(await callRpc(deps, 'kiosk_lookup_employee_verified', { p_line_user_id: lineUserId, p_identifier: identifier }), withResult)
  }
  if (action === 'kiosk_check_in') {
    const employeeId = uuidOrNull(body.employee_id)
    const kioskAction = body.kiosk_action === 'check_in' || body.kiosk_action === 'check_out' ? body.kiosk_action : null
    if (!employeeId || !kioskAction) return badRequest()
    // 照片只接受本專案 selfies bucket 的公開網址（前端上傳後取得）；其他網址不寫進出勤紀錄
    const photoPrefix = `${deps.env('SUPABASE_URL') || ''}/storage/v1/object/public/selfies/`
    let photoUrl: string | null = null
    if (body.photo_url != null && body.photo_url !== '') {
      if (typeof body.photo_url !== 'string' || body.photo_url.length > 500 || !deps.env('SUPABASE_URL') || !body.photo_url.startsWith(photoPrefix)) {
        return badRequest('照片網址不正確')
      }
      photoUrl = body.photo_url
    }
    const coord = (v: unknown, max: number): number | null | undefined => {
      if (v == null || v === '') return null
      const n = typeof v === 'number' ? v : NaN
      return Number.isFinite(n) && Math.abs(n) <= max ? n : undefined
    }
    const lat = coord(body.latitude, 90)
    const lng = coord(body.longitude, 180)
    if (lat === undefined || lng === undefined) return badRequest('定位資料不正確')
    return rpcResult(await callRpc(deps, 'kiosk_check_in_verified', {
      p_line_user_id: lineUserId, p_employee_id: employeeId, p_action: kioskAction,
      p_photo_url: photoUrl, p_latitude: lat, p_longitude: lng,
    }), withResult)
  }
  if (action === 'kiosk_lunch_status') {
    const allowed = ['action', 'liff_access_token', 'employee_id']
    const employeeId = uuidOrNull(body.employee_id)
    if (!onlyKeys(body, allowed) || !employeeId) return badRequest('便當資料不正確')
    return rpcResult(await callRpc(deps, 'kiosk_lunch_today_status_verified', {
      p_line_user_id: lineUserId, p_employee_id: employeeId,
    }), withResult)
  }
  if (action === 'kiosk_lunch_default') {
    const allowed = ['action', 'liff_access_token', 'employee_id']
    const employeeId = uuidOrNull(body.employee_id)
    if (!onlyKeys(body, allowed) || !employeeId) return badRequest('便當資料不正確')
    return rpcResult(await callRpc(deps, 'kiosk_lunch_apply_default_verified', {
      p_line_user_id: lineUserId, p_employee_id: employeeId,
    }), withResult)
  }
  if (action === 'kiosk_lunch') {
    const allowed = ['action', 'liff_access_token', 'employee_id', 'choice']
    const employeeId = uuidOrNull(body.employee_id)
    const choice = body.choice === 'regular' || body.choice === 'vegetarian' || body.choice === 'none' ? body.choice : null
    if (!onlyKeys(body, allowed) || !employeeId || !choice) return badRequest('便當資料不正確')
    return rpcResult(await callRpc(deps, 'kiosk_lunch_today_verified', {
      p_line_user_id: lineUserId, p_employee_id: employeeId, p_choice: choice,
    }), withResult)
  }
  if (action === 'kiosk_leave') {
    const allowed = ['action', 'liff_access_token', 'employee_id', 'leave_type', 'start_date', 'end_date', 'reason', 'leave_period', 'leave_start_time', 'leave_end_time']
    const employeeId = uuidOrNull(body.employee_id)
    const leaveType = typeof body.leave_type === 'string' && VERIFIED_LEAVE_TYPES.has(body.leave_type) ? body.leave_type : null
    const period = typeof body.leave_period === 'string' && VERIFIED_LEAVE_PERIODS.has(body.leave_period) ? body.leave_period : null
    const start = isRealDate(body.start_date) ? body.start_date : null
    const end = isRealDate(body.end_date) ? body.end_date : null
    const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
    const startTime = typeof body.leave_start_time === 'string' && TIME_RE.test(body.leave_start_time) ? body.leave_start_time : null
    const endTime = typeof body.leave_end_time === 'string' && TIME_RE.test(body.leave_end_time) ? body.leave_end_time : null
    if (!onlyKeys(body, allowed) || !employeeId || !leaveType || !period || !start || !end || end < start || !reason || reason.length > 1000) return badRequest('請假資料不正確')
    if ((period !== 'full_day' && start !== end) || (period === 'hourly' && (!startTime || !endTime || endTime <= startTime)))
      return badRequest('請假時段不正確')
    if (period !== 'hourly' && (body.leave_start_time != null || body.leave_end_time != null)) return badRequest('請假時段不正確')
    return rpcResult(await callRpc(deps, 'kiosk_submit_leave_verified', {
      p_line_user_id: lineUserId, p_employee_id: employeeId, p_leave_type: leaveType,
      p_start_date: start, p_end_date: end, p_reason: reason, p_leave_period: period,
      p_leave_start_time: period === 'hourly' ? startTime : null, p_leave_end_time: period === 'hourly' ? endTime : null,
    }), withResult)
  }
  if (action === 'kiosk_makeup') {
    const allowed = ['action', 'liff_access_token', 'employee_id', 'punch_date', 'punch_type', 'punch_time', 'reason']
    const employeeId = uuidOrNull(body.employee_id)
    const date = isRealDate(body.punch_date) ? body.punch_date : null
    const type = body.punch_type === 'clock_in' || body.punch_type === 'clock_out' ? body.punch_type : null
    const time = typeof body.punch_time === 'string' && TIME_RE.test(body.punch_time) ? body.punch_time : null
    const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
    if (!onlyKeys(body, allowed) || !employeeId || !date || !type || !time || !reason || reason.length > 1000) return badRequest('補卡資料不正確')
    return rpcResult(await callRpc(deps, 'kiosk_submit_makeup_verified', {
      p_line_user_id: lineUserId, p_employee_id: employeeId, p_punch_date: date,
      p_punch_type: type, p_punch_time: time, p_reason: reason,
    }), withResult)
  }

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
    const rawIds: unknown[] = Array.isArray(body.request_ids) ? body.request_ids : []
    if (!decision || rawIds.length === 0 || rawIds.length > MAX_BATCH_REVIEWS || rawIds.some((i) => !uuidOrNull(i))) return badRequest()
    const ids = [...new Set(rawIds as string[])]   // 重複的 id 只處理一次（indexOf 才能正確算出未處理的筆數）
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

  // ---- 換班審核（133：核准＝同一交易互換兩人班別並結案；拒絕＝記錄原因）----
  if (action === 'shift_swap_review') {
    const decision = body.decision === 'approve' || body.decision === 'reject' ? body.decision : null
    const requestId = uuidOrNull(body.request_id)
    if (!decision || !requestId) return badRequest()
    return rpcResult(await callRpc(deps, 'review_shift_swap_request', {
      p_company_id: companyId, p_line_user_id: lineUserId, p_request_id: requestId, p_decision: decision,
      p_reason: typeof body.reason === 'string' ? body.reason.slice(0, 500) : null,
    }), withResult)
  }

  // ---- 員工端換班（139）：申請人＝LINE 驗證的本人；只有對象本人能同意／拒絕 ----
  if (action === 'shift_swap_create') {
    const targetId = uuidOrNull(body.target_id)
    const swapDate = isRealDate(body.swap_date) ? body.swap_date : null
    if (!targetId || !swapDate) return badRequest()
    return rpcResult(await callRpc(deps, 'shift_swap_request_create', {
      p_company_id: companyId, p_line_user_id: lineUserId, p_target_id: targetId, p_swap_date: swapDate,
      p_reason: typeof body.reason === 'string' ? body.reason.slice(0, 500) : null,
    }), withResult)
  }
  if (action === 'shift_swap_respond') {
    const decision = body.decision === 'agree' || body.decision === 'decline' ? body.decision : null
    const requestId = uuidOrNull(body.request_id)
    if (!decision || !requestId) return badRequest()
    return rpcResult(await callRpc(deps, 'shift_swap_request_respond', {
      p_company_id: companyId, p_line_user_id: lineUserId, p_request_id: requestId, p_decision: decision,
    }), withResult)
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
