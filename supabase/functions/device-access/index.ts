import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ allowed: false, code: 'METHOD_NOT_ALLOWED' }, 405);

  try {
    const url = requiredEnv('SUPABASE_URL');
    const serviceKey = requiredEnv('SUPABASE_SERVICE_ROLE_KEY');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? requiredEnv('SUPABASE_PUBLISHABLE_KEY');
    const body = await req.json().catch(() => ({}));
    const rawDeviceId = clean(body.deviceId, 256);
    const rawInstallationId = clean(body.installationId, 256);
    if (!rawDeviceId || !rawInstallationId) {
      return json({ allowed: false, code: 'INVALID_DEVICE', message: 'Device identity is unavailable.' }, 200);
    }

    const pepper = Deno.env.get('DEVICE_ID_PEPPER') ?? '';
    const deviceHash = await sha256(`${pepper}:device:${rawDeviceId}`);
    const installationHash = await sha256(`${pepper}:install:${rawInstallationId}`);
    const service = createClient(url, serviceKey, { auth: { persistSession: false } });

    let userId: string | null = null;
    const authHeader = req.headers.get('Authorization');
    if (authHeader && !authHeader.endsWith(anonKey)) {
      const authClient = createClient(url, anonKey, {
        auth: { persistSession: false },
        global: { headers: { Authorization: authHeader } },
      });
      const { data } = await authClient.auth.getUser();
      userId = data.user?.id ?? null;
    }

    const ip = requestIp(req);
    const now = new Date().toISOString();
    const metadata = {
      device_hash: deviceHash,
      installation_hash: installationHash,
      platform: clean(body.platform, 32) || 'unknown',
      device_model: clean(body.deviceModel, 120),
      os_version: clean(body.osVersion, 64),
      app_version: clean(body.appVersion, 64),
      last_ip: ip,
      last_seen_at: now,
    };

    const { data: existing } = await service
      .from('app_devices').select('id, first_ip').eq('device_hash', deviceHash).maybeSingle();
    const { data: device, error: deviceError } = await service
      .from('app_devices')
      .upsert(existing ? metadata : { ...metadata, first_ip: ip }, { onConflict: 'device_hash' })
      .select('id').single();
    if (deviceError || !device) throw deviceError ?? new Error('Device registration failed');

    if (userId) {
      const { data: profile } = await service
        .from('profiles').select('is_banned, is_deleted').eq('id', userId).maybeSingle();
      if (profile?.is_banned || profile?.is_deleted) {
        return json({
          allowed: false,
          code: profile.is_deleted ? 'ACCOUNT_DELETED' : 'ACCOUNT_BLOCKED',
          message: profile.is_deleted ? 'This account is no longer available.' : 'This account is temporarily blocked.',
        }, 200);
      }

      await service.from('app_device_users').upsert({
        device_id: device.id,
        user_id: userId,
        last_seen_at: now,
      }, { onConflict: 'device_id,user_id' });
    }

    const { data: activeBlock } = await service
      .from('device_blocks').select('id').eq('device_id', device.id).is('unblocked_at', null).maybeSingle();
    if (activeBlock) {
      return json({
        allowed: false,
        code: 'DEVICE_BLOCKED',
        message: 'This device has been permanently blocked from using the app.',
      }, 200);
    }

    return json({ allowed: true, code: 'ALLOWED' }, 200);
  } catch (error) {
    console.error('device-access', error);
    return json({ allowed: false, code: 'CHECK_FAILED', message: 'Unable to verify this device. Please retry.' }, 503);
  }
});

function clean(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const result = value.trim().slice(0, max);
  return result || null;
}

function requestIp(req: Request): string | null {
  const raw = req.headers.get('cf-connecting-ip')
    ?? req.headers.get('x-real-ip')
    ?? req.headers.get('x-forwarded-for')?.split(',')[0]
    ?? null;
  const value = raw?.trim();
  return value && /^[0-9a-fA-F:.]+$/.test(value) ? value : null;
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function requiredEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

function json(payload: unknown, status: number) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
