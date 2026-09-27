import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { handleLinePush } from './handler.ts'

serve((req) => handleLinePush(req, {
  fetch,
  env: (key) => Deno.env.get(key),
  log: (msg) => console.warn(msg),
}))
