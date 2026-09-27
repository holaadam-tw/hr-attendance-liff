// line-auth：LIFF access token → Supabase Auth session（P1 身分根治 Phase 1；只建立 session，不強制任何權限）
//
// 流程：
//   1. 向 LINE 驗證 LIFF access token（與 line-push 同一套：client_id 白名單、expires_in > 0、/v2/profile 取 userId）
//   2. line_auth_resolve（service role）：這個 LINE userId 是不是在職員工／平台管理員、所屬公司、是否已有 Auth 帳號
//      - 不是（known=false）→ 403 not_linked，不建帳號
//   3. 沒有 Auth 帳號 → admin API 建立（email_confirm=true，app_metadata.line_user_id＋company_ids）
//      有 → 公司清單變了才更新 app_metadata
//      帳號 email 是系統產生的「<userId>@<網域>」，只當內部識別，不會寄信
//   4. admin generate_link（type=magiclink，不寄信，只拿 hashed_token）→ POST /auth/v1/verify（token_hash）換 session
//      → 不需要 JWT secret，session 由 Supabase Auth 自己簽發、可正常 refresh
//      /verify 有「每 IP 5 分鐘 30 次」限制（Edge Function 共用出口 IP）：被 429 時改回傳 token_hash，
//      讓前端自己呼叫 verifyOtp（限制改算在使用者自己的 IP）
//   5. 驗證回來的 user 真的是這個 LINE userId 的帳號，才回傳
//
// 絕不記錄 token（LIFF access token、hashed_token、access/refresh token）。

import { verifyLiffAccessToken, type Deps } from '../line-push/handler.ts'

export const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

export const DEFAULT_EMAIL_DOMAIN = 'line-auth.invalid'

function json(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
}
const fail = (status: number, code: string, error: string) => json({ ok: false, status, code, error }, status)

export function syntheticEmail(lineUserId: string, domain: string): string {
  return lineUserId.toLowerCase() + '@' + domain
}

type Http = { ok: boolean; status: number; data: any }

async function call(deps: Deps, path: string, init: { method: string; body?: unknown; key: 'service' | 'anon' }): Promise<Http> {
  const url = deps.env('SUPABASE_URL')
  const service = deps.env('SUPABASE_SERVICE_ROLE_KEY')
  const anon = deps.env('SUPABASE_ANON_KEY') || service
  const key = init.key === 'service' ? service : anon
  if (!url || !service || !key) return { ok: false, status: 0, data: null }
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', apikey: key }
    // admin API 需要 service role 的 Authorization；/verify 只要 apikey
    if (init.key === 'service') headers.Authorization = `Bearer ${service}`
    const res = await deps.fetch(url + path, {
      method: init.method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    })
    const data = await res.json().catch(() => null)
    return { ok: res.ok, status: res.status, data }
  } catch (_) {
    return { ok: false, status: 0, data: null }
  }
}

const sameIds = (a: unknown, b: unknown) =>
  Array.isArray(a) && Array.isArray(b) && a.length === b.length && [...a].sort().join(',') === [...b].sort().join(',')

export async function handleLineAuth(req: Request, deps: Deps): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return fail(405, 'method_not_allowed', 'method not allowed')
  const log = deps.log || (() => {})
  try {
    const body = await req.json().catch(() => null)
    const liffToken = body && typeof body.liff_access_token === 'string' ? body.liff_access_token : ''
    if (!liffToken) return fail(400, 'bad_request', '缺少必要參數')

    // 1. LINE 身分
    const lineUserId = await verifyLiffAccessToken(deps, liffToken)
    if (!lineUserId) return fail(401, 'unauthenticated', 'LINE 登入已過期，請重新開啟頁面')

    // 2. 是誰
    const resolved = await call(deps, '/rest/v1/rpc/line_auth_resolve', { method: 'POST', key: 'service', body: { p_line_user_id: lineUserId } })
    if (resolved.status === 404) return fail(503, 'db_not_migrated', '資料庫尚未更新（135）')
    if (!resolved.ok || !resolved.data || typeof resolved.data !== 'object') return fail(503, 'service_unavailable', '登入服務暫時無法使用')
    const r = resolved.data
    if (r.success !== true) {
      log('line-auth: resolve refused ' + String(r.error_code))
      return fail(r.error_code === 'duplicate_auth_user' ? 409 : 400, String(r.error_code || 'failed'), '登入帳號資料異常，請通知系統管理員')
    }
    if (r.known !== true) return fail(403, 'not_linked', '此 LINE 帳號尚未綁定員工')
    const companyIds: string[] = Array.isArray(r.company_ids) ? r.company_ids.filter((c: unknown) => typeof c === 'string') : []
    const appMetadata = { line_user_id: lineUserId, company_ids: companyIds }

    // 3. Auth 帳號
    let userId: string | null = typeof r.auth_user_id === 'string' ? r.auth_user_id : null
    let email: string = typeof r.auth_email === 'string' && r.auth_email ? r.auth_email : syntheticEmail(lineUserId, deps.env('LINE_AUTH_EMAIL_DOMAIN') || DEFAULT_EMAIL_DOMAIN)
    let created = false
    if (!userId) {
      const c = await call(deps, '/auth/v1/admin/users', {
        method: 'POST', key: 'service',
        body: { email, email_confirm: true, app_metadata: appMetadata, user_metadata: {} },
      })
      if (c.status === 422) {
        // 同 email 已有帳號、但 app_metadata 沒對上這個 LINE userId → 不接管，交給人處理
        log('line-auth: email exists without matching line_user_id')
        return fail(409, 'identity_conflict', '登入帳號資料異常，請通知系統管理員')
      }
      if (!c.ok || !c.data || typeof c.data.id !== 'string') return fail(503, 'service_unavailable', '登入服務暫時無法使用')
      userId = c.data.id
      email = typeof c.data.email === 'string' ? c.data.email : email
      created = true
    } else {
      const u = await call(deps, `/auth/v1/admin/users/${userId}`, { method: 'GET', key: 'service' })
      if (!u.ok || !u.data) return fail(503, 'service_unavailable', '登入服務暫時無法使用')
      if (!sameIds(u.data.app_metadata?.company_ids, companyIds)) {
        const up = await call(deps, `/auth/v1/admin/users/${userId}`, { method: 'PUT', key: 'service', body: { app_metadata: appMetadata } })
        if (!up.ok) return fail(503, 'service_unavailable', '登入服務暫時無法使用')
      }
    }

    // 4. 換 session（不寄信）
    const link = await call(deps, '/auth/v1/admin/generate_link', { method: 'POST', key: 'service', body: { type: 'magiclink', email } })
    const hashed = link.data && typeof link.data.hashed_token === 'string' ? link.data.hashed_token
      : (link.data?.properties && typeof link.data.properties.hashed_token === 'string' ? link.data.properties.hashed_token : '')
    const linkUserId = link.data && typeof link.data.id === 'string' ? link.data.id : (link.data?.user?.id ?? null)
    if (!link.ok || !hashed) return fail(503, 'service_unavailable', '登入服務暫時無法使用')
    if (linkUserId && linkUserId !== userId) {
      log('line-auth: generate_link returned a different user')
      return fail(409, 'identity_conflict', '登入帳號資料異常，請通知系統管理員')
    }

    const v = await call(deps, '/auth/v1/verify', { method: 'POST', key: 'anon', body: { type: 'magiclink', token_hash: hashed } })
    if (v.status === 429) {
      // Edge Function 出口 IP 被 /verify 頻率限制擋住 → 讓前端自己換（限制算在使用者 IP）
      log('line-auth: verify rate limited, handing token_hash to client')
      return json({ ok: true, status: 200, mode: 'token_hash', token_hash: hashed, verify_type: 'magiclink', user: { id: userId, line_user_id: lineUserId }, created }, 200)
    }
    const s = v.data
    if (!v.ok || !s || typeof s.access_token !== 'string' || typeof s.refresh_token !== 'string') {
      return fail(503, 'service_unavailable', '登入服務暫時無法使用')
    }
    // 5. 回來的 session 必須就是這個 LINE userId 的帳號
    if (s.user?.id !== userId || s.user?.app_metadata?.line_user_id !== lineUserId) {
      log('line-auth: verified session does not match the LINE user')
      return fail(409, 'identity_conflict', '登入帳號資料異常，請通知系統管理員')
    }
    log(`line-auth: session issued (${created ? 'new' : 'existing'} user)`)
    return json({
      ok: true, status: 200, mode: 'session', created,
      session: {
        access_token: s.access_token, refresh_token: s.refresh_token,
        expires_in: s.expires_in ?? null, expires_at: s.expires_at ?? null, token_type: s.token_type ?? 'bearer',
      },
      user: { id: userId, line_user_id: lineUserId, company_ids: companyIds },
    }, 200)
  } catch (_) {
    return fail(500, 'internal_error', '登入服務暫時無法使用')
  }
}
