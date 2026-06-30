// =====================================================================
// Agora RTC Token Generator — Supabase Edge Function
//
// The mobile app calls this to get a short-lived token before joining an
// Agora channel. The App Certificate stays here as a secret and is NEVER
// shipped in the app.
//
// Secrets required (set via `supabase secrets set`):
//   AGORA_APP_ID
//   AGORA_APP_CERTIFICATE
//
// Deploy:  supabase functions deploy agora-token
// =====================================================================

import { RtcTokenBuilder, RtcRole } from 'npm:agora-token@2.0.5';
import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const appId = Deno.env.get('AGORA_APP_ID');
    const appCertificate = Deno.env.get('AGORA_APP_CERTIFICATE');
    if (!appId || !appCertificate) {
      return json({ error: 'Agora secrets not configured' }, 500);
    }

    // --- Auth: only signed-in users can request a token ---
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'Missing Authorization header' }, 401);

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } }
    );
    const { data: { user }, error: userErr } = await supabase.auth.getUser();
    if (userErr || !user) return json({ error: 'Not authenticated' }, 401);

    // --- Inputs ---
    const body = await req.json().catch(() => ({}));
    const channelName: string = body.channelName;
    const role: string = body.role === 'publisher' ? 'publisher' : 'subscriber';
    // Agora uid: 0 lets Agora assign one, but we want a stable per-user uid.
    // Use a 32-bit uint derived from the user's id, or accept an explicit one.
    const uid: number = typeof body.uid === 'number' ? body.uid : hashUid(user.id);

    if (!channelName || typeof channelName !== 'string') {
      return json({ error: 'channelName is required' }, 400);
    }

    const rtcRole = role === 'publisher' ? RtcRole.PUBLISHER : RtcRole.SUBSCRIBER;
    const expireSeconds = 60 * 60; // 1 hour token; app should refresh before expiry
    const privilegeExpireSeconds = expireSeconds;

    const token = RtcTokenBuilder.buildTokenWithUid(
      appId,
      appCertificate,
      channelName,
      uid,
      rtcRole,
      expireSeconds,
      privilegeExpireSeconds
    );

    return json({ token, appId, uid, channelName, role, expiresIn: expireSeconds }, 200);
  } catch (e) {
    return json({ error: String(e?.message || e) }, 500);
  }
});

function json(payload: unknown, status: number) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

// Deterministic 32-bit uint from a UUID string (so a user keeps the same
// Agora uid across joins — useful for muting/identifying remote users).
function hashUid(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) {
    h = (Math.imul(31, h) + id.charCodeAt(i)) | 0;
  }
  // Keep it positive and within Agora's uint32 range (avoid 0).
  return (h >>> 0) % 4294967295 || 1;
}