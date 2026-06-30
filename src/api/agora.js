import { supabase } from './supabase';
import { TENANT_CONFIG } from '../../tenant.config';

// Derived from the tenant's Supabase project — the agora-token edge
// function lives in the same project so the host name is the same
// as the data API. One tenant.config edit moves both.
const TOKEN_FN_URL = `${TENANT_CONFIG.supabase.url}/functions/v1/agora-token`;

/**
 * Deterministic Agora uid from a Supabase user id — MUST match the
 * `hashUid` function in supabase/functions/agora-token/index.ts exactly,
 * so a viewer can compute the host's / a guest's uid and render their feed.
 */
export function agoraUidFromId(id) {
  if (!id) return 0;
  let h = 0;
  for (let i = 0; i < id.length; i++) {
    h = (Math.imul(31, h) + id.charCodeAt(i)) | 0;
  }
  return (h >>> 0) % 4294967295 || 1;
}

// Single attempt at the edge function. Separated from the public
// fetchAgoraToken so the retry wrapper can compose it cleanly.
async function _attemptFetchAgoraToken(channelName, role, sessionAccessToken) {
  const res = await fetch(TOKEN_FN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${sessionAccessToken}`,
    },
    body: JSON.stringify({ channelName, role }),
  });
  const data = await res.json();
  if (!res.ok || !data?.token) {
    const err = new Error(data?.error || `HTTP ${res.status}`);
    err.code = res.status;
    throw err;
  }
  return data; // { token, appId, uid, channelName, role, expiresIn }
}

/**
 * Fetches a short-lived Agora RTC token from our Supabase Edge Function.
 *
 * Adds one automatic retry after a 250ms backoff because dev networks
 * (and budget mobile data) blip exactly often enough that a single
 * fetch sometimes fails for no real reason. The pre-warm path then
 * gives up and the fallback in useAgoraEngine picks it up — but each
 * hop logged a scary-looking warning. With the retry the warning rate
 * drops to almost zero for healthy networks; legitimate failures
 * (token endpoint down, auth missing) still bubble up as null.
 *
 * @param {string} channelName  the room channel (we use broadcaster_id)
 * @param {'publisher'|'subscriber'} role  publisher = host/guest, subscriber = viewer
 * @returns {Promise<{token:string, appId:string, uid:number, channelName:string}|null>}
 */
export async function fetchAgoraToken(channelName, role) {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
      if (__DEV__) console.warn('Agora token: no session');
      return null;
    }

    try {
      return await _attemptFetchAgoraToken(channelName, role, session.access_token);
    } catch (firstErr) {
      // Quick retry — covers the vast majority of "Network request failed"
      // warnings we see in dev and on flaky 4G.
      await new Promise((r) => setTimeout(r, 250));
      try {
        return await _attemptFetchAgoraToken(channelName, role, session.access_token);
      } catch (secondErr) {
        if (__DEV__) {
          console.warn(
            'Agora token fetch failed after retry:',
            secondErr?.message || firstErr?.message
          );
        }
        return null;
      }
    }
  } catch (err) {
    if (__DEV__) console.warn('Agora token fetch failed:', err?.message);
    return null;
  }
}
