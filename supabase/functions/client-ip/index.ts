// Returns the caller's public IP address and stores nothing.
// Deploy with JWT verification left on, so only a signed-in desktop app can call it.
import { CORS, json } from '../_shared/http.ts';
import { clientAddress } from '../_shared/ip.ts';

Deno.serve((req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'GET' && req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const authorization = req.headers.get('Authorization') ?? '';
  if (!authorization.startsWith('Bearer ') || authorization.length < 20) return json({ error: 'Not signed in' }, 401);
  const ip = clientAddress(req.headers);
  if (!ip) return json({ error: 'No public address' }, 404);
  return json({ ip });
});
