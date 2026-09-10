export const INTRO_LOAD_TIMEOUT_MS = 6000;

export const normalizeIntroSource = (source) => {
  if (typeof source === 'number') return source;
  if (typeof source === 'string') {
    const uri = source.trim();
    if (!uri) return null;
    return { uri: uri.startsWith('//') ? `https:${uri}` : uri };
  }
  if (!source || typeof source !== 'object') return null;
  if (typeof source.assetId === 'number' && !source.uri) return source;
  if (typeof source.uri !== 'string') return source;

  const uri = source.uri.trim();
  if (!uri) return null;
  return { ...source, uri: uri.startsWith('//') ? `https:${uri}` : uri };
};

export const introSourceKey = (source) => {
  const normalized = normalizeIntroSource(source);
  if (normalized == null) return 'none';
  if (typeof normalized === 'number') return `asset:${normalized}`;
  try {
    return JSON.stringify(normalized);
  } catch (_) {
    return String(normalized?.uri || normalized);
  }
};

export const shouldUseIntroFallback = (primary, fallback) => (
  normalizeIntroSource(fallback) != null
  && introSourceKey(primary) !== introSourceKey(fallback)
);

const cleanUrl = (value) => typeof value === 'string' && value.trim() ? value.trim() : null;

/**
 * Convert a freshly fetched profile row (snake_case) or an in-memory user
 * (camelCase) into the entrance-intro shape used by the broadcast screen.
 * Explicit database nulls win over stale cached values so an admin unequip is
 * respected immediately too.
 */
export const assignedIntroFromProfile = (profile = {}, cached = {}) => {
  const field = (snake, camel) => {
    if (Object.prototype.hasOwnProperty.call(profile, snake)) return profile[snake];
    if (Object.prototype.hasOwnProperty.call(profile, camel)) return profile[camel];
    return cached?.[camel] ?? null;
  };
  return {
    ...cached,
    id: profile?.id || cached?.id || null,
    name: profile?.full_name || profile?.name || cached?.name || null,
    selectedMallIntro: field('selected_mall_intro', 'selectedMallIntro'),
    selectedMallIntroVideoUrl: field('selected_mall_intro_video_url', 'selectedMallIntroVideoUrl'),
    selectedMallIntroThumbnailUrl: field('selected_mall_intro_thumbnail_url', 'selectedMallIntroThumbnailUrl'),
  };
};

/**
 * Resolve denormalized VIP/SVIP intro assignments without requiring the
 * profile's cached URL columns to be populated. Mall/personal intros are
 * resolved from mall_intro_items by the caller because that catalog is RLS
 * scoped per user and is not part of GlobalStateContext.
 * @param {{
 *   introId?: string | null,
 *   videoUrl?: string | null,
 *   thumbnailUrl?: string | null,
 *   vipSubscriptions?: any[],
 *   svipSubscriptions?: any[]
 * }} [assignment]
 */
export const resolveAssignedIntroFromPackageCatalogs = ({
  introId,
  videoUrl,
  thumbnailUrl,
  vipSubscriptions = [],
  svipSubscriptions = [],
} = {}) => {
  const id = typeof introId === 'string' ? introId.trim() : introId;
  const explicitVideoUrl = cleanUrl(videoUrl);
  if (explicitVideoUrl) {
    return { introId: id || null, videoUrl: explicitVideoUrl, thumbnailUrl: cleanUrl(thumbnailUrl) };
  }
  if (!id) return { introId: null, videoUrl: null, thumbnailUrl: cleanUrl(thumbnailUrl) };

  const vipMatch = (Array.isArray(vipSubscriptions) ? vipSubscriptions : [])
    .find((item) => `vip:${item?.id}:intro` === id);
  if (vipMatch) {
    return {
      introId: id,
      videoUrl: cleanUrl(vipMatch.intro_video_url),
      thumbnailUrl: cleanUrl(thumbnailUrl) || cleanUrl(vipMatch.intro_thumbnail_url),
    };
  }

  for (const item of (Array.isArray(svipSubscriptions) ? svipSubscriptions : [])) {
    if (`svip:${item?.id}:intro:1` === id) {
      return {
        introId: id,
        videoUrl: cleanUrl(item.intro_video_url),
        thumbnailUrl: cleanUrl(thumbnailUrl) || cleanUrl(item.intro_thumbnail_url),
      };
    }
    if (`svip:${item?.id}:intro:2` === id) {
      return {
        introId: id,
        videoUrl: cleanUrl(item.intro2_video_url),
        thumbnailUrl: cleanUrl(thumbnailUrl) || cleanUrl(item.intro2_thumbnail_url),
      };
    }
  }

  return { introId: id, videoUrl: null, thumbnailUrl: cleanUrl(thumbnailUrl) };
};
