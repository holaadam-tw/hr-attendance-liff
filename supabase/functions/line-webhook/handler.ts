// line-webhook 核心邏輯（與 serve 分開，方便在 Node / Deno 直接測）
//
// 只用 reply（回覆訊息不計入 LINE 每月推播額度）：
//   #id   → 回 群組／聊天室／使用者 ID（原功能，不變）
//   #待辦 → 回「我的待辦」（員工：自己的缺卡缺時、待審申請；主管：全公司待審數量）
//           只在 1 對 1 聊天回覆，群組裡只提示改用私訊，避免個資出現在群組
//
// 安全：#待辦 會回個人資料，必須驗 LINE 簽章（X-Line-Signature，HMAC-SHA256 + Channel secret）。
//       沒設定 LINE_CHANNEL_SECRET 時 #待辦 只回「尚未啟用」，不查資料。

export type Env = (key: string) => string | undefined

export interface Deps {
  fetch: typeof fetch
  env: Env
  log?: (msg: string) => void
}

export const TODO_COMMANDS = ['#待辦', '待辦', '#todo', '#待辦事項']

function toBase64(bytes: ArrayBuffer): string {
  let bin = ''
  const arr = new Uint8Array(bytes)
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i])
  return btoa(bin)
}

export async function computeSignature(secret: string, body: string | Uint8Array<ArrayBuffer>): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const bytes: Uint8Array<ArrayBuffer> = typeof body === 'string' ? enc.encode(body) : body
  return toBase64(await crypto.subtle.sign('HMAC', key, bytes))
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

async function reply(deps: Deps, token: string, replyToken: string, text: string): Promise<void> {
  await deps.fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ replyToken, messages: [{ type: 'text', text: text.slice(0, 4900) }] }),
  })
}

async function pullTodo(deps: Deps, lineUserId: string): Promise<string> {
  const url = deps.env('SUPABASE_URL')
  const key = deps.env('SUPABASE_SERVICE_ROLE_KEY')
  if (!url || !key) return '待辦查詢暫時無法使用，請改用打卡系統查看。'
  try {
    const res = await deps.fetch(`${url}/rest/v1/rpc/line_pull_todo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: key, Authorization: `Bearer ${key}` },
      body: JSON.stringify({ p_line_user_id: lineUserId }),
    })
    if (!res.ok) return '待辦查詢暫時無法使用，請改用打卡系統查看。'
    const data = await res.json()
    return typeof data === 'string' && data ? data : '目前沒有待處理事項 👍'
  } catch (_) {
    return '待辦查詢暫時無法使用，請改用打卡系統查看。'
  }
}

export async function handleLineWebhook(req: Request, deps: Deps): Promise<Response> {
  const log = deps.log || (() => {})
  if (req.method === 'GET') return new Response('OK', { status: 200 })
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 })

  try {
    // 簽章要對「原始位元組」算，不先轉字串
    const rawBytes = new Uint8Array(await req.arrayBuffer())
    const raw = new TextDecoder().decode(rawBytes)
    const token = deps.env('LINE_CHANNEL_TOKEN')
    if (!token) {
      log('LINE_CHANNEL_TOKEN not set')
      return new Response('OK', { status: 200 })
    }

    const secret = deps.env('LINE_CHANNEL_SECRET')
    let signatureOk = false
    if (secret) {
      const given = req.headers.get('x-line-signature') || ''
      signatureOk = given !== '' && timingSafeEqual(given, await computeSignature(secret, rawBytes))
      if (!signatureOk) {
        log('invalid LINE signature')
        return new Response('Unauthorized', { status: 401 })
      }
    }

    const body = raw ? JSON.parse(raw) : {}
    const events = Array.isArray(body.events) ? body.events : []

    for (const event of events) {
      if (event.type !== 'message' || event.message?.type !== 'text') continue
      // 中文輸入法常打出全形「＃」或夾全形空白：NFKC 轉半形再比對
      const text = String(event.message.text || '').normalize('NFKC').trim()
      const replyToken = event.replyToken
      if (!replyToken) continue

      if (text === '#id') {
        let replyText: string
        if (event.source?.type === 'group') replyText = `Group ID:\n${event.source.groupId}`
        else if (event.source?.type === 'room') replyText = `Room ID:\n${event.source.roomId}`
        else replyText = `User ID:\n${event.source?.userId || 'unknown'}`
        await reply(deps, token, replyToken, replyText)
        continue
      }

      if (TODO_COMMANDS.includes(text.toLowerCase()) || TODO_COMMANDS.includes(text)) {
        if (event.source?.type !== 'user') {
          await reply(deps, token, replyToken, '為了保護個人資料，請私訊官方帳號輸入「#待辦」查詢。')
          continue
        }
        if (!secret || !signatureOk) {
          await reply(deps, token, replyToken, '「#待辦」查詢尚未啟用（管理者需設定 LINE_CHANNEL_SECRET）。')
          continue
        }
        const userId = event.source?.userId
        const todo = userId ? await pullTodo(deps, userId) : '無法辨識您的 LINE 帳號。'
        await reply(deps, token, replyToken, todo)
      }
    }

    return new Response('OK', { status: 200 })
  } catch (e) {
    log('Webhook error: ' + (e instanceof Error ? e.message : String(e)))
    return new Response('OK', { status: 200 })
  }
}
