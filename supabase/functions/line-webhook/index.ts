import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

serve(async (req) => {
  // LINE Webhook verification (GET)
  if (req.method === 'GET') {
    return new Response('OK', { status: 200 })
  }

  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 })
  }

  try {
    const body = await req.json()
    const events = body.events || []
    const token = Deno.env.get('LINE_CHANNEL_TOKEN')

    if (!token) {
      console.error('LINE_CHANNEL_TOKEN not set')
      return new Response('OK', { status: 200 })
    }

    for (const event of events) {
      if (event.type !== 'message' || event.message?.type !== 'text') continue

      const text = event.message.text.trim()
      const replyToken = event.replyToken

      if (text === '#id') {
        let replyText: string

        if (event.source?.type === 'group') {
          replyText = `Group ID:\n${event.source.groupId}`
        } else if (event.source?.type === 'room') {
          replyText = `Room ID:\n${event.source.roomId}`
        } else {
          replyText = `User ID:\n${event.source?.userId || 'unknown'}`
        }

        await fetch('https://api.line.me/v2/bot/message/reply', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
          },
          body: JSON.stringify({
            replyToken,
            messages: [{ type: 'text', text: replyText }],
          }),
        })
      }
    }

    return new Response('OK', { status: 200 })
  } catch (e) {
    console.error('Webhook error:', e.message)
    return new Response('OK', { status: 200 })
  }
})
