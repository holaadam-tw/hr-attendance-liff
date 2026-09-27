import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { handleLineWebhook } from './handler.ts'

serve((req) => handleLineWebhook(req, {
  fetch,
  env: (key) => Deno.env.get(key),
  log: (msg) => console.error(msg),
}))
