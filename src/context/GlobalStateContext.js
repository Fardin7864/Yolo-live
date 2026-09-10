import React, { createContext, useState, useContext, useEffect, useCallback, useRef } from 'react';
import { Alert, AppState } from 'react-native';
import { router } from 'expo-router';
import { supabase } from '../api/supabase';

const GlobalStateContext = createContext();

export const GlobalStateProvider = ({ children }) => {
  // --- Core State ---
  const [diamonds, setDiamonds] = useState(0);
  const [beans, setBeans] = useState(0);
  const [role, setRole] = useState('user');
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  // Agency context (loaded from DB)
  const [ownedAgency, setOwnedAgency] = useState(null); // if user is an agency owner
  const [myAgency, setMyAgency] = useState(null);       // if user is a bound host

  // Reseller context (loaded from DB) — if user is an approved reseller
  const [myReseller, setMyReseller] = useState(null);

  // System settings (driven by admin panel `system_settings` table)
  const [systemSettings, setSystemSettings] = useState({
    maintenance_mode: false,
    maintenance_message: '',
    maintenance_bypass_user_ids: [],
    signup_enabled: true,
    live_enabled: true,
    gifting_enabled: true,
    games_enabled: true,
    platform_name: 'Popular Live',
  });

  // Per-game admin toggles (driven by `game_settings` table). Defaults
  // keep supported games visible until the first fetch lands so nothing
  // flashes off on cold start.
  const [gameSettings, setGameSettings] = useState({
    greedy_lion:    { is_active: true, win_chance_percent: 60 },
    greedy_pro:     { is_active: true, win_chance_percent: 60 },
    lucky_dice:     { is_active: true, win_chance_percent: 100 },
    tin_patti_pro:  { is_active: true, win_chance_percent: 60 },
    crash:           { is_active: false },
  });
  const [gameSettingsLoaded, setGameSettingsLoaded] = useState(false);

  // ============================================================
  // PROFILE FETCH
  // ============================================================
  const fallbackUserFromAuth = (authUser) => {
    const meta = authUser?.user_metadata || {};
    const name = meta.full_name || meta.name || authUser?.email?.split('@')[0] || 'User';
    return {
      name,
      avatar: meta.avatar_url || meta.picture || `https://api.dicebear.com/7.x/avataaars/svg?seed=${authUser?.id}`,
      level: 1,
      lifetimeDiamondsSpent: 0,
      id: authUser?.id,
      displayId: null,
      phone: authUser?.phone || null,
      bio: '',
      gender: 'female',
      country: null,
      vipType: null,
      vipExpiresAt: null,
      commentTagId: null,
      commentTagName: null,
      commentTagUrl: null,
      isBanned: false,
      agencyId: null,
      selectedProfileFrame: null,
      selectedProfileFrameUrl: null,
      ownedProfileFrames: [],
      selectedMallIntro: null,
      selectedMallIntroVideoUrl: null,
      selectedMallIntroThumbnailUrl: null,
      ownedMallIntros: [],
      pushNotificationsEnabled: true,
      dmNotificationsEnabled: true,
    };
  };

  const fetchProfile = async (userId, attempt = 0, authUser = null) => {
    try {
      let profileResponse = await supabase
        .from('profiles')
        .select('*, comment_tag:comment_tags(id, name, image_url)')
        .eq('id', userId)
        .maybeSingle();

      // Keep this release usable while migration 126 is being applied.
      // PostgREST cannot resolve the relation until its schema cache sees
      // comment_tags/comment_tag_id, so fall back to the legacy profile
      // query and simply omit the optional tag during that short window.
      if (profileResponse.error && /comment[_ ]?tag|relationship/i.test(profileResponse.error.message || '')) {
        profileResponse = await supabase
          .from('profiles')
          .select('*')
          .eq('id', userId)
          .maybeSingle();
      }

      const { data, error } = profileResponse;

      if (error) throw error;

      if (!data) {
        if (attempt === 0) {
          try {
            await supabase.rpc('ensure_my_profile');
          } catch (_) {}
          await new Promise((resolve) => setTimeout(resolve, 350));
          return fetchProfile(userId, 1, authUser);
        }

        console.warn('Profile not found for current auth user; keeping session with temporary profile.');
        const fallback = fallbackUserFromAuth(authUser || { id: userId });
        setUser(fallback);
        setDiamonds(0);
        setBeans(0);
        setRole('user');
        setOwnedAgency(null);
        setMyAgency(null);
        setMyReseller(null);
        return;
      }

      if (data) {
        if (data.is_banned === true || data.is_deleted === true) {
          setUser(null);
          setDiamonds(0);
          setBeans(0);
          setRole('user');
          try { await supabase.auth.signOut(); } catch (_) {}
          try { router.replace('/auth/login'); } catch (_) {}
          return;
        }
        const commentTag = Array.isArray(data.comment_tag) ? data.comment_tag[0] : data.comment_tag;
        setUser({
          name: data.full_name || 'User',
          nickname: data.nickname || null,
          avatar: data.avatar_url || `https://api.dicebear.com/7.x/avataaars/svg?seed=${data.id}`,
          level: data.level || 1,
          // EXP toward the next level — increments inside the gifts_log
          // trigger (migration 50). The "My Level" screen reads this
          // directly to render the progress bar.
          lifetimeDiamondsSpent: Number(data.lifetime_diamonds_spent) || 0,
          id: data.id,
          displayId: data.display_id,
          phone: data.phone_number,
          bio: data.bio || '',
          gender: data.gender || 'female',
          country: data.country || null,
          role: data.role || 'user',
          vipType: data.vip_type,
          vipExpiresAt: data.vip_expires_at,
          commentTagId: data.comment_tag_id || null,
          commentTagName: commentTag?.name || null,
          commentTagUrl: commentTag?.image_url || null,
          isBanned: data.is_banned,
          agencyId: data.agency_id,
          selectedProfileFrame: data.selected_profile_frame || null,
          selectedProfileFrameUrl: data.selected_profile_frame_url || null,
          ownedProfileFrames: Array.isArray(data.owned_profile_frames) ? data.owned_profile_frames : [],
          selectedMallIntro: data.selected_mall_intro || null,
          selectedMallIntroVideoUrl: data.selected_mall_intro_video_url || null,
          selectedMallIntroThumbnailUrl: data.selected_mall_intro_thumbnail_url || null,
          ownedMallIntros: Array.isArray(data.owned_mall_intros) ? data.owned_mall_intros : [],
          // Notification preferences (migration 55) — default to true if
          // the columns don't exist on a profile from before the
          // migration ran.
          pushNotificationsEnabled: data.push_notifications_enabled !== false,
          dmNotificationsEnabled:   data.dm_notifications_enabled   !== false,
        });
        setDiamonds(data.diamonds || 0);
        setBeans(data.beans || 0);
        setRole(data.role || 'user');

        // Load agency + reseller context after profile
        await Promise.all([
          loadOwnedAgency(data.id),
          data.agency_id ? loadMyAgency(data.agency_id) : Promise.resolve(),
          loadMyReseller(data.id),
        ]);
      }
    } catch (err) {
      console.error('Error fetching profile:', err.message);
    } finally {
      setLoading(false);
    }
  };

  // ============================================================
  // AGENCY LOADERS
  // ============================================================
  const loadOwnedAgency = async (userId) => {
    const { data } = await supabase
      .from('agencies')
      .select('*')
      .eq('owner_id', userId)
      .maybeSingle();
    setOwnedAgency(data || null);
  };

  const loadMyAgency = async (agencyId) => {
    const { data } = await supabase
      .from('agencies')
      .select('*')
      .eq('id', agencyId)
      .maybeSingle();
    setMyAgency(data || null);
  };

  const loadMyReseller = async (userId) => {
    const { data } = await supabase
      .from('resellers')
      .select('*')
      .eq('user_id', userId)
      .neq('status', 'inactive')
      .maybeSingle();
    setMyReseller(data || null);
  };

  const refreshAgencies = useCallback(async () => {
    if (!user?.id) return;
    await loadOwnedAgency(user.id);
    if (user.agencyId) await loadMyAgency(user.agencyId);
    else setMyAgency(null);
  }, [user?.id, user?.agencyId]);

  const refreshMyReseller = useCallback(async () => {
    if (!user?.id) return;
    await loadMyReseller(user.id);
  }, [user?.id]);

  // ============================================================
  // SYSTEM SETTINGS (admin-controlled feature toggles + maintenance)
  // ============================================================
  const loadSystemSettings = useCallback(async () => {
    const { data, error } = await supabase
      .from('system_settings')
      .select('key, value');
    if (error) {
      // Table may not exist yet — silently keep defaults
      return;
    }
    const merged = {};
    (data || []).forEach((row) => { merged[row.key] = row.value; });
    setSystemSettings((prev) => ({ ...prev, ...merged }));
  }, []);

  useEffect(() => {
    loadSystemSettings();
    // Realtime — when admin flips a switch, all clients pick it up
    const ch = supabase
      .channel(`system-settings-${Date.now()}`)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'system_settings' },
        () => loadSystemSettings()
      )
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [loadSystemSettings]);

  // ============================================================
  // GAME SETTINGS (per-game admin toggles + win chance)
  // ============================================================
  const loadGameSettings = useCallback(async () => {
    const { data, error } = await supabase
      .from('game_settings')
      .select('id, is_active, win_chance_percent');
    if (error) { setGameSettingsLoaded(true); return; }
    const merged = {};
    (data || []).forEach((row) => {
      merged[row.id] = {
        is_active: !!row.is_active,
        win_chance_percent: row.win_chance_percent ?? 50,
      };
    });
    setGameSettings((prev) => ({ ...prev, ...merged }));
    setGameSettingsLoaded(true);
  }, []);

  useEffect(() => {
    loadGameSettings();
    const ch = supabase
      .channel(`game-settings-${Date.now()}`)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'game_settings' },
        () => loadGameSettings()
      )
      .subscribe();
    return () => { try { supabase.removeChannel(ch); } catch (_) {} };
  }, [loadGameSettings]);

  // ============================================================
  // ADMIN-MANAGED CATALOGS — gifts, vip_tiers, tasks, badges,
  // level_tiers. Each one used to be hardcoded in a mobile screen;
  // they now flow from the admin panel into the app in realtime so
  // pricing / content edits don't need an app deploy.
  //
  // Pattern is identical for all five: empty default state, a small
  // loader, and a single subscription per table that re-runs the
  // loader on any change.
  // ============================================================
  const [gifts, setGifts]             = useState([]);
  const [vipTiers, setVipTiers]       = useState([]);
  const [vipSubscriptions, setVipSubscriptions] = useState([]);
  const [svipSubscriptions, setSvipSubscriptions] = useState([]);
  const [tasks, setTasks]             = useState([]);
  const [homeBanners, setHomeBanners] = useState([]);
  const [badges, setBadges]           = useState([]);
  const [levelTiers, setLevelTiers]   = useState([]);
  // Audio room backgrounds (mig 88) — the catalog every host browses
  // in the audio-live Tools sheet, plus the set of paid templates THIS
  // user has bought. Free templates are not in `myOwnedTemplates` —
  // they're implicitly owned via diamond_cost = 0. Both have realtime
  // subs so admin uploads / purchases propagate instantly.
  const [audioTemplates, setAudioTemplates]       = useState([]);
  const [myOwnedTemplates, setMyOwnedTemplates]   = useState([]);

  const loadGifts = useCallback(async () => {
    const { data, error } = await supabase
      .from('gifts')
      .select('id, name, diamond_cost, bean_value, category, animation_path, animation_url, sound_path, sound_url, required_vip_type, is_active, display_order, loop, custom_duration')
      .eq('is_active', true)
      .order('category')
      .order('display_order', { ascending: true });
    if (error) return;
    setGifts(data || []);
  }, []);

  const loadVipTiers = useCallback(async () => {
    const { data, error } = await supabase
      .from('vip_tiers')
      .select('id, name, rank, badge_color, pricing, perks, is_active, display_order')
      .eq('is_active', true)
      .order('display_order', { ascending: true });
    if (error) return;
    setVipTiers(data || []);
  }, []);

  const loadVipSubscriptions = useCallback(async () => {
    const { data, error } = await supabase
      .from('vip_subscriptions')
      .select('id, name, price, duration_days, features, intro_name, intro_thumbnail_url, intro_video_url, frame_name, frame_url, accent_color, is_active, display_order')
      .eq('is_active', true)
      .order('display_order', { ascending: true })
      .order('created_at', { ascending: true });
    if (error) return;
    setVipSubscriptions(data || []);
  }, []);

  const loadSvipSubscriptions = useCallback(async () => {
    const { data, error } = await supabase
      .from('svip_subscriptions')
      .select('id, name, price, duration_days, features, intro_name, intro_thumbnail_url, intro_video_url, intro2_name, intro2_thumbnail_url, intro2_video_url, frame_name, frame_url, frame2_name, frame2_url, accent_color, is_active, display_order')
      .eq('is_active', true)
      .order('display_order', { ascending: true })
      .order('created_at', { ascending: true });
    if (error) return;
    setSvipSubscriptions(data || []);
  }, []);

  const loadTasks = useCallback(async () => {
    const { data, error } = await supabase
      .from('tasks')
      .select('id, title, reward, reward_currency, target, action, audience, description, is_active, display_order')
      .eq('is_active', true)
      .order('display_order', { ascending: true });
    if (error) return;
    setTasks(data || []);
  }, []);

  const loadBadges = useCallback(async () => {
    const { data, error } = await supabase
      .from('badges')
      .select('id, name, description, icon_url, criteria, is_active, display_order')
      .eq('is_active', true)
      .order('display_order', { ascending: true });
    if (error) return;
    setBadges(data || []);
  }, []);

  const loadLevelTiers = useCallback(async () => {
    const { data, error } = await supabase
      .from('level_tiers')
      .select('id, name, color, icon, min_level, max_level, display_order')
      .order('min_level', { ascending: true });
    if (error) return;
    setLevelTiers(data || []);
  }, []);

  // Active home-screen banners — admin-controllable carousels above
  // and below the live grid (mig 100 added `position`). Capped at
  // 5 per slot, enforced by migration 128.
  // older rows. Rows without a `position` column (DB version before
  // mig 100) default to 'top' so the legacy path keeps working.
  const loadHomeBanners = useCallback(async () => {
    const { data, error } = await supabase
      .from('home_banners')
      .select('id, image_url, link_url, display_order, is_active, position')
      .eq('is_active', true)
      .order('display_order', { ascending: true })
      .limit(10);
    if (error) return;
    setHomeBanners(data || []);
  }, []);

  // Audio room background catalog (mig 88). Free templates are
  // browseable by everyone; paid ones require a purchase row in
  // user_audio_templates before apply_audio_template will accept
  // them.
  const loadAudioTemplates = useCallback(async () => {
    const { data, error } = await supabase
      .from('audio_templates')
      .select('id, name, background_url, preview_url, diamond_cost, is_active, display_order')
      .eq('is_active', true)
      .order('display_order', { ascending: true })
      .order('created_at', { ascending: false });
    if (error) return;
    setAudioTemplates(data || []);
  }, []);

  const loadMyOwnedTemplates = useCallback(async () => {
    const { data: { user: u } } = await supabase.auth.getUser();
    if (!u) { setMyOwnedTemplates([]); return; }
    const { data } = await supabase
      .from('user_audio_templates')
      .select('template_id, purchased_at')
      .eq('user_id', u.id);
    setMyOwnedTemplates(data || []);
  }, []);

  // Purchase action — single-button entry point used by the audio
  // template sheet. Returns the RPC's JSON so the caller can show
  // the right alert. Realtime sub on `user_audio_templates` picks
  // up the new ownership row and refetches the list, so we don't
  // optimistically push it here.
  const purchaseAudioTemplate = useCallback(async (templateId) => {
    if (!templateId) return { success: false, message: 'Missing template' };
    const { data, error } = await supabase.rpc('purchase_audio_template', {
      p_template_id: templateId,
    });
    if (error) return { success: false, message: error.message };
    return data || { success: false, message: 'Unknown error' };
  }, []);

  // ============================================================
  // TASK CENTER state — daily login + per-mission progress.
  // The mobile Task screen reads these directly; the action-bump
  // RPCs (claimDailyLogin, claimShareTask, bumpWatchProgress,
  // claimTaskReward) live further down. Realtime subscriptions
  // hydrate this state whenever the DB rows change (e.g. a gift
  // triggers progress, or admin tunes a daily-login reward).
  // ============================================================
  const [dailyLoginRewards, setDailyLoginRewards] = useState([]);   // [{day_index, diamonds}]
  const [dailyLoginClaims,  setDailyLoginClaims]  = useState([]);   // mine, recent
  const [todayProgress,     setTodayProgress]     = useState([]);   // [{task_id, count, completed_at, claimed_at}]

  const loadDailyLoginRewards = useCallback(async () => {
    const { data } = await supabase
      .from('daily_login_rewards')
      .select('day_index, diamonds')
      .order('day_index', { ascending: true });
    setDailyLoginRewards(data || []);
  }, []);

  const loadDailyLoginClaims = useCallback(async () => {
    const sb = supabase;
    const { data: { user: u } } = await sb.auth.getUser();
    if (!u) { setDailyLoginClaims([]); return; }
    const { data } = await sb
      .from('daily_login_claims')
      .select('claim_date, day_index, diamonds_awarded')
      .eq('user_id', u.id)
      .order('claim_date', { ascending: false })
      .limit(35);
    setDailyLoginClaims(data || []);
  }, []);

  const loadTodayProgress = useCallback(async () => {
    const sb = supabase;
    const { data: { user: u } } = await sb.auth.getUser();
    if (!u) { setTodayProgress([]); return; }
    // UTC today (matches the SQL functions).
    const todayUtc = new Date().toISOString().slice(0, 10);
    const { data } = await sb
      .from('user_task_progress')
      .select('task_id, count, completed_at, claimed_at')
      .eq('user_id', u.id)
      .eq('progress_date', todayUtc);
    setTodayProgress(data || []);
  }, []);

  useEffect(() => {
    loadGifts(); loadVipTiers(); loadVipSubscriptions(); loadSvipSubscriptions(); loadTasks(); loadBadges(); loadLevelTiers();
    loadDailyLoginRewards(); loadDailyLoginClaims(); loadTodayProgress();
    loadHomeBanners();
    loadAudioTemplates(); loadMyOwnedTemplates();
    const ch = supabase
      .channel(`catalogs-${Date.now()}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'gifts'              }, () => loadGifts())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'vip_tiers'          }, () => loadVipTiers())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'vip_subscriptions'  }, () => loadVipSubscriptions())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'svip_subscriptions' }, () => loadSvipSubscriptions())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks'              }, () => loadTasks())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'badges'             }, () => loadBadges())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'level_tiers'        }, () => loadLevelTiers())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'daily_login_rewards'}, () => loadDailyLoginRewards())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'user_task_progress' }, () => loadTodayProgress())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'home_banners'       }, () => loadHomeBanners())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'audio_templates'    }, () => loadAudioTemplates())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'user_audio_templates'}, () => loadMyOwnedTemplates())
      .subscribe();
    return () => { try { supabase.removeChannel(ch); } catch (_) {} };
  }, [loadGifts, loadVipTiers, loadVipSubscriptions, loadSvipSubscriptions, loadTasks, loadBadges, loadLevelTiers, loadDailyLoginRewards, loadDailyLoginClaims, loadTodayProgress, loadHomeBanners, loadAudioTemplates, loadMyOwnedTemplates]);

  // ============================================================
  // FOLLOW SYSTEM (works app-wide — live rooms, profiles, search)
  // ============================================================
  // Follow a user by their UUID. Idempotent (duplicate = already following).
  const followUser = useCallback(async (targetId) => {
    if (!user?.id || !targetId || targetId === user.id) return false;
    const { error } = await supabase
      .from('follows')
      .insert({ follower_id: user.id, following_id: targetId });
    if (error && !String(error.message).toLowerCase().includes('duplicate')) {
      console.warn('follow error:', error.message);
      return false;
    }
    return true;
  }, [user?.id]);

  const unfollowUser = useCallback(async (targetId) => {
    if (!user?.id || !targetId) return false;
    const { error } = await supabase
      .from('follows')
      .delete()
      .eq('follower_id', user.id)
      .eq('following_id', targetId);
    if (error) { console.warn('unfollow error:', error.message); return false; }
    return true;
  }, [user?.id]);

  // Is the current user following targetId?
  const isFollowing = useCallback(async (targetId) => {
    if (!user?.id || !targetId) return false;
    const { data } = await supabase
      .from('follows')
      .select('id')
      .eq('follower_id', user.id)
      .eq('following_id', targetId)
      .maybeSingle();
    return !!data;
  }, [user?.id]);

  // ============================================================
  // AUTH / SESSION
  // ============================================================
  useEffect(() => {
    let cancelled = false;
    let subscription;

    const initAuth = async () => {
      supabase.auth.getSession()
      .then(({ data: { session }, error }) => {
        if (cancelled) return;
        if (error || !session) {
          // Stale/invalid refresh token — clear it out so we don't loop
          if (error?.message?.toLowerCase().includes('refresh token')) {
            supabase.auth.signOut().catch(() => {});
          }
          setLoading(false);
          return;
        }
        fetchProfile(session.user.id, 0, session.user);
      })
      .catch((err) => {
        if (cancelled) return;
        console.warn('getSession failed:', err?.message);
        supabase.auth.signOut().catch(() => {});
        setLoading(false);
      });

      const authListener = supabase.auth.onAuthStateChange((event, session) => {
        if (cancelled) return;
        // TOKEN_REFRESHED with no session = refresh failed; treat as signed-out
        if (event === 'TOKEN_REFRESHED' && !session) {
          supabase.auth.signOut().catch(() => {});
        }
        if (session) {
          fetchProfile(session.user.id, 0, session.user);
        } else {
          setUser(null);
          setDiamonds(0);
          setBeans(0);
          setRole('user');
          setOwnedAgency(null);
          setMyAgency(null);
          setMyReseller(null);
          setLoading(false);
        }
      });
      subscription = authListener.data.subscription;
    };

    initAuth();

    return () => {
      cancelled = true;
      subscription?.unsubscribe();
    };
  }, []);

  // ============================================================
  // REALTIME: profile changes (balance, ban, role, etc.)
  // ============================================================
  // Balance lock — games freeze realtime diamond/bean updates while the
  // result animation is playing so the user doesn't see their balance
  // jump before they're shown they won/lost. Pending updates are queued
  // and applied once unlockBalance() is called.
  const balanceLockedRef = useRef(false);
  const pendingBalanceRef = useRef(null);

  const lockBalanceUpdates = useCallback(() => {
    balanceLockedRef.current = true;
    pendingBalanceRef.current = null;
  }, []);

  const unlockBalanceUpdates = useCallback(() => {
    balanceLockedRef.current = false;
    const queued = pendingBalanceRef.current;
    if (queued) {
      if (queued.diamonds !== undefined) setDiamonds(queued.diamonds);
      if (queued.beans !== undefined) setBeans(queued.beans);
      pendingBalanceRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!user?.id) return;
    // First-mount guard so the SUBSCRIBED callback below doesn't fire a
    // redundant fetchProfile in addition to the initial profile load.
    // It only refetches on subsequent SUBSCRIBED transitions, which are
    // the auto-reconnect ones we actually need to recover from.
    let initialSubscribe = true;
    const profileSubscription = supabase
      .channel(`profile-changes-${user.id}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'profiles', filter: `id=eq.${user.id}` },
        async (payload) => {
          const n = payload.new;
          let nextCommentTag = null;
          if (n.comment_tag_id) {
            const { data: tag } = await supabase
              .from('comment_tags')
              .select('id, name, image_url')
              .eq('id', n.comment_tag_id)
              .maybeSingle();
            nextCommentTag = tag || null;
          }

          // Hold diamond/bean updates while a game animation is playing.
          // Everything else (name, role, ban, etc.) still applies live.
          if (balanceLockedRef.current) {
            pendingBalanceRef.current = {
              diamonds: n.diamonds,
              beans: n.beans,
            };
          } else {
            if (n.diamonds !== undefined) setDiamonds(n.diamonds);
            if (n.beans !== undefined) setBeans(n.beans);
          }

          if (n.role) setRole(n.role);

          // Enforce a fresh ban / soft-delete the moment the server flips
          // the flag — without this the user kept their cached session
          // until the next manual refresh and could keep gifting / chatting
          // after being banned by an admin or after deleting their account.
          // Fire-and-forget: signOut + replace navigation; the outer effect
          // cleanup will remove this subscription as user.id becomes null.
          if (n.is_banned === true || n.is_deleted === true) {
            (async () => {
              try { await supabase.auth.signOut(); } catch (_) {}
              try { router.replace('/auth/login'); } catch (_) {}
            })();
            return; // skip the rest of the user-merge below
          }

          setUser((prev) => prev ? ({
            ...prev,
            name: n.full_name ?? prev.name,
            avatar: n.avatar_url ?? prev.avatar,
            bio: n.bio ?? prev.bio,
            gender: n.gender ?? prev.gender,
            country: n.country ?? prev.country,
            vipType: n.vip_type ?? prev.vipType,
            vipExpiresAt: n.vip_expires_at ?? prev.vipExpiresAt,
            commentTagId: n.comment_tag_id || null,
            commentTagName: nextCommentTag?.name || null,
            commentTagUrl: nextCommentTag?.image_url || null,
            isBanned: n.is_banned ?? prev.isBanned,
            agencyId: n.agency_id !== undefined ? n.agency_id : prev.agencyId,
            selectedProfileFrame: n.selected_profile_frame !== undefined
              ? n.selected_profile_frame
              : prev.selectedProfileFrame,
            selectedProfileFrameUrl: n.selected_profile_frame_url !== undefined
              ? n.selected_profile_frame_url
              : prev.selectedProfileFrameUrl,
            ownedProfileFrames: Array.isArray(n.owned_profile_frames)
              ? n.owned_profile_frames
              : prev.ownedProfileFrames,
            selectedMallIntro: n.selected_mall_intro !== undefined
              ? n.selected_mall_intro
              : prev.selectedMallIntro,
            selectedMallIntroVideoUrl: n.selected_mall_intro_video_url !== undefined
              ? n.selected_mall_intro_video_url
              : prev.selectedMallIntroVideoUrl,
            selectedMallIntroThumbnailUrl: n.selected_mall_intro_thumbnail_url !== undefined
              ? n.selected_mall_intro_thumbnail_url
              : prev.selectedMallIntroThumbnailUrl,
            ownedMallIntros: Array.isArray(n.owned_mall_intros)
              ? n.owned_mall_intros
              : prev.ownedMallIntros,
            // Keep level + EXP in lock-step with the server so the
            // "My Level" screen reflects the live trigger-driven update
            // the instant a gift is sent.
            level: n.level ?? prev.level,
            lifetimeDiamondsSpent: n.lifetime_diamonds_spent !== undefined
              ? Number(n.lifetime_diamonds_spent)
              : prev.lifetimeDiamondsSpent,
            // Settings toggles live in profiles too — Settings screen
            // listens on these to re-seed its switches.
            pushNotificationsEnabled: n.push_notifications_enabled !== undefined
              ? n.push_notifications_enabled !== false
              : prev.pushNotificationsEnabled,
            dmNotificationsEnabled: n.dm_notifications_enabled !== undefined
              ? n.dm_notifications_enabled !== false
              : prev.dmNotificationsEnabled,
          }) : null);
        }
      )
      .subscribe((status) => {
        // Refetch on reconnect. Supabase Realtime auto-reconnects after
        // network blips, but events that fired during the disconnect
        // window are NOT replayed — that's the root cause of the
        // "I won but my diamonds appeared 5-7 minutes later" complaint.
        // The win UPDATE fired while the channel was reconnecting and
        // got dropped; the balance only caught up when the NEXT
        // UPDATE event happened (level up, next gift, etc.).
        if (status === 'SUBSCRIBED') {
          if (initialSubscribe) {
            initialSubscribe = false;
          } else {
            fetchProfile(user.id);
          }
        }
      });

    return () => { supabase.removeChannel(profileSubscription); };
  }, [user?.id]);

  // ============================================================
  // APPSTATE refetch — phone wake / app foreground = profile refresh
  // ============================================================
  // If the user backgrounds the app, wins a round (server credits, but
  // Realtime on a backgrounded RN app is unreliable on Android Doze),
  // and brings the app back later, the balance should land within
  // a beat of returning to foreground — not whenever the next
  // unrelated profile UPDATE happens to fire. Also catches the case
  // where the user takes a call / unlocks after a long lock.
  useEffect(() => {
    if (!user?.id) return undefined;
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') {
        fetchProfile(user.id);
      }
    });
    return () => { try { sub.remove(); } catch (_) {} };
  }, [user?.id]);

  // ============================================================
  // FINANCIAL ACTIONS — all server-side RPCs
  // ============================================================

  // 1. GIFT SENDING (called from broadcast room)
  const sendGiftSecurely = async (recipientId, giftId, cost, opts = {}) => {
    try {
      const { data, error } = await supabase.rpc('send_gift', {
        p_sender_id: user.id,
        p_recipient_id: recipientId,
        p_gift_id: giftId,
        p_diamond_cost: cost,
        p_room_id: opts.roomId || null,
        p_gift_name: opts.giftName || null,
        p_count: opts.count || 1,
      });
      if (error) throw error;
      if (!data.success) {
        Alert.alert('Transaction Failed', data.message || 'Could not send gift');
        return false;
      }
      // Re-read the profile after the committed server transaction. This is
      // deliberately not an optimistic subtraction: a realtime profile event
      // can arrive before an optimistic update and make the balance appear to
      // be deducted twice. A direct refresh always shows the server's final,
      // locked balance even if the device missed a realtime event.
      await fetchProfile(user.id);
      // No optimistic deduction here. The profiles realtime subscription
      // already pushes the authoritative `diamonds` value within ~100ms
      // (line 393). Doing both was racy: if the realtime UPDATE landed
      // first, the optimistic line then deducted AGAIN from the freshly
      // synced value — the user briefly saw double the cost gone.
      // Throttling in handleSendGift (400ms) ensures the realtime tick
      // has time to arrive between rapid taps.
      return true;
    } catch (err) {
      if (__DEV__) console.warn('Gifting Error:', err?.message);
      Alert.alert('Error', 'Could not complete gifting transaction.');
      return false;
    }
  };

  // 2. BEAN -> DIAMOND CONVERSION (host settlement)
  const convertBeansSecurely = async (amount, rate = 0.5) => {
    try {
      const { data, error } = await supabase.rpc('convert_beans_to_diamonds', {
        p_user_id: user.id,
        p_bean_amount: amount,
        p_rate: rate,
      });
      if (error) throw error;
      if (!data.success) {
        Alert.alert('Conversion Failed', data.message || 'Could not convert');
        return false;
      }
      setBeans((prev) => Math.max(0, prev - amount));
      setDiamonds((prev) => prev + (data.diamond_gain || 0));
      return true;
    } catch (err) {
      console.error('Conversion Error:', err);
      Alert.alert('Error', 'Could not complete conversion.');
      return false;
    }
  };

  // 3a. CREATE TOPUP REQUEST via RESELLER
  const createTopupRequest = async (resellerId, packageAmount, bdtValue) => {
    try {
      const { data, error } = await supabase.rpc('create_topup_request', {
        p_user_id: user.id,
        p_reseller_id: resellerId,
        p_package_amount: packageAmount,
        p_bdt_value: bdtValue,
      });
      if (error) throw error;
      if (!data.success) {
        Alert.alert('Request Failed', data.message || 'Could not create request');
        return null;
      }
      return data.request_id;
    } catch (err) {
      console.error('Topup Request Error:', err);
      Alert.alert('Error', 'Could not create top-up request.');
      return null;
    }
  };

  // 3b. CREATE TOPUP REQUEST via AGENCY (user buying from an agency's stock)
  const createAgencyTopupRequest = async (agencyId, packageAmount, bdtValue) => {
    try {
      const { data, error } = await supabase.rpc('create_agency_topup_request', {
        p_user_id: user.id,
        p_agency_id: agencyId,
        p_package_amount: packageAmount,
        p_bdt_value: bdtValue,
      });
      if (error) throw error;
      if (!data.success) {
        Alert.alert('Request Failed', data.message || 'Could not create request');
        return null;
      }
      return data.request_id;
    } catch (err) {
      console.error('Agency Topup Request Error:', err);
      Alert.alert('Error', 'Could not create agency top-up request.');
      return null;
    }
  };

  // 3c. APPLY AS RESELLER
  const applyReseller = async ({ businessName, contactLink, paymentMethods, nidNumber, notes }) => {
    try {
      const { data, error } = await supabase.rpc('apply_reseller', {
        p_user_id: user.id,
        p_business_name: businessName,
        p_contact_link: contactLink,
        p_payment_methods: paymentMethods || null,
        p_nid_number: nidNumber || null,
        p_notes: notes || null,
      });
      if (error) throw error;
      if (!data.success) {
        Alert.alert('Application Failed', data.message);
        return null;
      }
      return data.application_id;
    } catch (err) {
      console.error('Apply Reseller Error:', err);
      Alert.alert('Error', 'Could not submit application.');
      return null;
    }
  };

  // 3d. APPLY AS AGENCY OWNER
  const applyAgencyOwner = async ({ proposedName, proposedCode, contactLink, nidNumber, notes }) => {
    try {
      const { data, error } = await supabase.rpc('apply_agency_owner', {
        p_user_id: user.id,
        p_proposed_name: proposedName,
        p_proposed_code: proposedCode,
        p_contact_link: contactLink,
        p_nid_number: nidNumber || null,
        p_notes: notes || null,
      });
      if (error) throw error;
      if (!data.success) {
        Alert.alert('Application Failed', data.message);
        return null;
      }
      return data.application_id;
    } catch (err) {
      console.error('Apply Agency Error:', err);
      Alert.alert('Error', 'Could not submit application.');
      return null;
    }
  };

  // 3d-2. REQUEST RESELLER STOCK (reseller asks super admin for bulk diamonds)
  const requestResellerStock = async (diamondAmount, bdtValue, notes) => {
    try {
      const { data, error } = await supabase.rpc('request_reseller_stock', {
        p_user_id: user.id,
        p_diamond_amount: diamondAmount,
        p_bdt_value: bdtValue || null,
        p_notes: notes || null,
      });
      if (error) throw error;
      if (!data.success) {
        Alert.alert('Request Failed', data.message);
        return null;
      }
      return data.request_id;
    } catch (err) {
      console.error('Reseller Stock Request Error:', err);
      Alert.alert('Error', 'Could not request stock.');
      return null;
    }
  };

  // 3d-3. CONFIRM TOPUP AS RESELLER (deducts from reseller's own stock)
  const confirmTopupAsReseller = async (requestId) => {
    try {
      const { data, error } = await supabase.rpc('confirm_topup_request', {
        p_request_id: requestId,
        p_admin_id: user.id, // RPC accepts admin, agency owner, OR reseller
      });
      if (error) throw error;
      if (!data.success) {
        Alert.alert('Failed', data.message);
        return false;
      }
      await refreshMyReseller();
      return true;
    } catch (err) {
      console.error('Confirm Topup (reseller) Error:', err);
      Alert.alert('Error', 'Could not confirm.');
      return false;
    }
  };

  // 3e. REQUEST AGENCY STOCK (agency owner asks super admin for bulk diamonds)
  const requestAgencyStock = async (diamondAmount, bdtValue, notes) => {
    try {
      const { data, error } = await supabase.rpc('request_agency_stock', {
        p_owner_id: user.id,
        p_diamond_amount: diamondAmount,
        p_bdt_value: bdtValue || null,
        p_notes: notes || null,
      });
      if (error) throw error;
      if (!data.success) {
        Alert.alert('Request Failed', data.message);
        return null;
      }
      return data.request_id;
    } catch (err) {
      console.error('Stock Request Error:', err);
      Alert.alert('Error', 'Could not request stock.');
      return null;
    }
  };

  // 3f. CONFIRM TOPUP (used by agency owner from their dashboard)
  const confirmTopupAsAgency = async (requestId) => {
    try {
      const { data, error } = await supabase.rpc('confirm_topup_request', {
        p_request_id: requestId,
        p_admin_id: user.id, // RPC accepts either admin or agency owner
      });
      if (error) throw error;
      if (!data.success) {
        Alert.alert('Failed', data.message);
        return false;
      }
      await refreshAgencies();
      return true;
    } catch (err) {
      console.error('Confirm Topup Error:', err);
      Alert.alert('Error', 'Could not confirm.');
      return false;
    }
  };

  // 4. BIND TO AGENCY (host joins agency)
  const bindToAgency = async (agencyCode) => {
    try {
      const { data, error } = await supabase.rpc('bind_to_agency', {
        p_host_id: user.id,
        p_agency_code: agencyCode,
      });
      if (error) throw error;
      if (!data.success) {
        Alert.alert('Join Failed', data.message || 'Invalid agency code');
        return false;
      }
      Alert.alert('Request Sent', `Awaiting approval from ${data.agency_name}`);
      return true;
    } catch (err) {
      console.error('Agency Bind Error:', err);
      Alert.alert('Error', 'Could not bind to agency.');
      return false;
    }
  };

  // 5. REQUEST PAYOUT (all host cash-outs go to the non-login Bins Holder)
  const requestPayout = async (beansAmount) => {
    try {
      const { data, error } = await supabase.rpc('request_bins_withdrawal', { p_beans_amount: beansAmount, p_note: null });
      if (error) throw error;
      if (!data.success) {
        Alert.alert('Payout Failed', data.message || 'Could not request payout');
        return null;
      }
      setBeans((prev) => Math.max(0, prev - beansAmount));
      return data;
    } catch (err) {
      console.error('Payout Error:', err);
      Alert.alert('Error', 'Could not request payout.');
      return null;
    }
  };

  // 6. AGENCY OWNER: transfer diamonds to a host
  const agencyTransferToHost = async (hostId, diamondAmount) => {
    if (!ownedAgency) {
      Alert.alert('Error', 'You do not own an agency.');
      return false;
    }
    try {
      const { data, error } = await supabase.rpc('agency_transfer_to_host', {
        p_agency_id: ownedAgency.id,
        p_owner_id: user.id,
        p_host_id: hostId,
        p_diamond_amount: diamondAmount,
      });
      if (error) throw error;
      if (!data.success) {
        Alert.alert('Transfer Failed', data.message);
        return false;
      }
      await refreshAgencies();
      return true;
    } catch (err) {
      console.error('Agency Transfer Error:', err);
      Alert.alert('Error', 'Could not complete transfer.');
      return false;
    }
  };

  // ============================================================
  // TASK CENTER actions
  //   claimDailyLogin / claimTaskReward — UI-driven claims
  //   bumpWatchProgress / claimShareTask — silent action bumps
  // All four go through SECURITY DEFINER RPCs from migration 70.
  // Each helper refreshes local state so the screen reflects the
  // change without waiting on the realtime UPDATE round-trip.
  // ============================================================
  // Local re-pull of the current user's profile. The exported
  // `refreshUser` alias on the context value isn't visible inside
  // the provider, so we call fetchProfile directly here.
  const refetchMe = () => (user?.id ? fetchProfile(user.id) : Promise.resolve());

  const claimDailyLogin = async () => {
    try {
      const { data, error } = await supabase.rpc('claim_daily_login');
      if (error || !data?.success) {
        return data || { success: false, message: error?.message || 'Claim failed' };
      }
      await Promise.all([loadDailyLoginClaims(), refetchMe()]);
      return data;
    } catch (err) {
      if (__DEV__) console.warn('claimDailyLogin:', err?.message);
      return { success: false, message: 'Network error' };
    }
  };

  const claimTaskReward = async (taskId) => {
    try {
      const { data, error } = await supabase.rpc('claim_task_reward', { p_task_id: taskId });
      if (error || !data?.success) {
        return data || { success: false, message: error?.message || 'Claim failed' };
      }
      await Promise.all([loadTodayProgress(), refetchMe()]);
      return data;
    } catch (err) {
      if (__DEV__) console.warn('claimTaskReward:', err?.message);
      return { success: false, message: 'Network error' };
    }
  };

  const bumpWatchProgress = async (minutes = 1) => {
    try {
      await supabase.rpc('bump_watch_progress', { p_minutes: minutes });
    } catch (_) { /* best effort — don't disrupt the viewer */ }
  };

  const claimShareTask = async () => {
    try {
      await supabase.rpc('claim_share_task');
      await loadTodayProgress();
    } catch (_) { /* best effort */ }
  };

  // 7. AGENCY OWNER: convert accumulated beans to diamond stock
  const agencyConvertBeans = async (beanAmount) => {
    if (!ownedAgency) {
      Alert.alert('Error', 'You do not own an agency.');
      return false;
    }
    try {
      const { data, error } = await supabase.rpc('agency_convert_beans', {
        p_agency_id: ownedAgency.id,
        p_owner_id: user.id,
        p_bean_amount: beanAmount,
      });
      if (error) throw error;
      if (!data.success) {
        Alert.alert('Conversion Failed', data.message);
        return false;
      }
      await refreshAgencies();
      return true;
    } catch (err) {
      console.error('Agency Convert Error:', err);
      Alert.alert('Error', 'Could not complete conversion.');
      return false;
    }
  };

  // 8. AGENCY OWNER: update payout rate
  const updateAgencyRate = async (newRate) => {
    if (!ownedAgency) return false;
    const { error } = await supabase
      .from('agencies')
      .update({ payout_rate: newRate })
      .eq('id', ownedAgency.id);
    if (error) {
      Alert.alert('Error', 'Could not update rate.');
      return false;
    }
    await refreshAgencies();
    return true;
  };

  // 9. AGENCY OWNER: mark payout as paid
  const markPayoutPaid = async (payoutId) => {
    try {
      const { data, error } = await supabase.rpc('mark_payout_paid', {
        p_payout_id: payoutId,
        p_actor_id: user.id,
      });
      if (error) throw error;
      if (!data.success) {
        Alert.alert('Failed', data.message);
        return false;
      }
      return true;
    } catch (err) {
      console.error('Mark Paid Error:', err);
      return false;
    }
  };

  // 10b. AGENCY OWNER: reject a pending join request
  const rejectAgencyJoin = async (hostId) => {
    if (!ownedAgency) return false;
    try {
      const { data, error } = await supabase.rpc('reject_agency_join', {
        p_agency_id: ownedAgency.id,
        p_owner_id: user.id,
        p_host_id: hostId,
      });
      if (error) throw error;
      if (!data.success) {
        Alert.alert('Failed', data.message);
        return false;
      }
      return true;
    } catch (err) {
      console.error('Reject Join Error:', err);
      return false;
    }
  };

  // 10c. AGENCY OWNER: rename agency
  const updateAgencyName = async (newName) => {
    if (!ownedAgency) return false;
    try {
      const { data, error } = await supabase.rpc('update_agency_name', {
        p_agency_id: ownedAgency.id,
        p_owner_id: user.id,
        p_new_name: newName,
      });
      if (error) throw error;
      if (!data.success) {
        Alert.alert('Failed', data.message);
        return false;
      }
      await refreshAgencies();
      return true;
    } catch (err) {
      console.error('Rename Agency Error:', err);
      return false;
    }
  };

  // 10. AGENCY OWNER: approve member join request
  const approveAgencyMember = async (hostId) => {
    if (!ownedAgency) return false;
    try {
      const { data, error } = await supabase.rpc('approve_agency_member', {
        p_agency_id: ownedAgency.id,
        p_host_id: hostId,
        p_owner_id: user.id,
      });
      if (error) throw error;
      if (!data.success) {
        Alert.alert('Failed', data.message);
        return false;
      }
      await refreshAgencies();
      return true;
    } catch (err) {
      console.error('Approve Member Error:', err);
      return false;
    }
  };

  // 11. LIVE STREAM lifecycle
  const startLiveStream = async (type, title, tag, coverUrl) => {
    try {
      const { data, error } = await supabase.rpc('start_live_stream', {
        p_broadcaster_id: user.id,
        p_type: type,
        p_title: title,
        p_tag: tag,
        p_cover_url: coverUrl,
      });
      if (error) throw error;
      return data.success ? data.stream_id : null;
    } catch (err) {
      // Quiet in prod — the broadcast room's own startLiveStream call
      // is a fallback for the live.js pre-warm, so a single failure
      // here doesn't break the flow. Loud warnings only spook the user.
      if (__DEV__) console.warn('Start Live Error:', err?.message || err);
      return null;
    }
  };

  const endLiveStream = async (streamId, peakViewers = 0) => {
    try {
      const { error } = await supabase.rpc('end_live_stream', {
        p_stream_id: streamId,
        p_peak_viewers: peakViewers,
      });
      return !error;
    } catch (err) {
      console.error('End Live Error:', err);
      return false;
    }
  };

  // ============================================================
  // QA-only role toggle (kept for testing)
  // ============================================================
  const toggleRole = () => {
    const newRole = role === 'host' ? 'agency_owner' : 'host';
    setRole(newRole);
  };

  const value = {
    // State
    diamonds,
    beans,
    role,
    user,
    loading,
    ownedAgency,
    myAgency,
    myReseller,
    systemSettings,
    gameSettings, gameSettingsLoaded, loadGameSettings,

    // Admin-managed catalogs (DB-driven, realtime)
    gifts,
    vipTiers,
    vipSubscriptions,
    svipSubscriptions,
    tasks,
    badges,
    levelTiers,
    homeBanners,
    loadHomeBanners,

    // Audio room templates (mig 88)
    audioTemplates,
    myOwnedTemplates,
    purchaseAudioTemplate,

    // Task center — daily login + per-mission progress
    dailyLoginRewards,
    dailyLoginClaims,
    todayProgress,
    claimDailyLogin,
    claimTaskReward,
    bumpWatchProgress,
    claimShareTask,

    // Setters (for optimistic UI)
    setDiamonds,
    setBeans,
    setRole,
    setUser,

    // Profile
    fetchProfile,
    // Convenience alias — re-pulls the current user's profile + diamonds.
    refreshUser: () => user?.id ? fetchProfile(user.id) : Promise.resolve(),
    refreshAgencies,
    refreshMyReseller,

    // Follow system (app-wide)
    followUser,
    unfollowUser,
    isFollowing,

    // Financial RPCs
    sendGiftSecurely,
    convertBeansSecurely,
    createTopupRequest,
    createAgencyTopupRequest,
    bindToAgency,
    requestPayout,
    agencyTransferToHost,

    // Agency owner salary view. Agency leave reviews are Super Admin-only.
    fetchAgencyHostEarnings: async (agencyId) => {
      const { data, error } = await supabase.rpc('agency_host_earnings', { p_agency_id: agencyId });
      if (error) { console.warn('host earnings:', error.message); return []; }
      return Array.isArray(data) ? data : [];
    },
    agencyConvertBeans,
    updateAgencyRate,
    markPayoutPaid,
    approveAgencyMember,
    rejectAgencyJoin,
    updateAgencyName,
    confirmTopupAsAgency,
    confirmTopupAsReseller,

    // Application + stock RPCs
    applyReseller,
    applyAgencyOwner,
    requestAgencyStock,
    requestResellerStock,

    // Live stream
    startLiveStream,
    endLiveStream,

    // Balance lock (used by games so realtime doesn't reveal the result early)
    lockBalanceUpdates,
    unlockBalanceUpdates,

    // Dev
    toggleRole,
  };

  return (
    <GlobalStateContext.Provider value={value}>
      {children}
    </GlobalStateContext.Provider>
  );
};

export const useGlobalState = () => {
  const context = useContext(GlobalStateContext);
  if (!context) {
    throw new Error('useGlobalState must be used within a GlobalStateProvider');
  }
  return context;
};
