import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView, Animated, Modal, Alert, Image,
  useWindowDimensions,
} from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { supabase } from '../../api/supabase';
import { useGlobalState } from '../../context/GlobalStateContext';
import { formatCompactNumber } from '../../utils/format';
import { BRAND } from '../../theme/brand';

// Card constants only used for the post-reveal visual flourish — the
// actual win/lose decision is the server's job now.
const SUITS  = ['♠', '♥', '♣', '♦'];
const VALUES = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

// Deterministic shuffle so every viewer of the same round sees the
// same set of cards. Without this each device ran its own
// Math.random() and viewers saw different hands on the same chair.
// mulberry32 is a 32-bit non-crypto PRNG — fine for visual flair.
function hashStringToInt(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CHIP_VALUES = [100, 1000, 10000, 100000];
const POSITIONS   = ['A', 'B', 'C'];
const POS_COLOR   = { A: '#06B6D4', B: '#D946EF', C: '#F59E0B' };

// Hand label helper — purely cosmetic, doesn't affect payout.
const getHandRank = (cards) => {
  if (!cards || cards.length < 3) return null;
  const sortedValues = [...cards].sort((a, b) => VALUES.indexOf(b.value) - VALUES.indexOf(a.value));
  const isFlush = cards.every(c => c.suit === cards[0].suit);
  const vIndices = sortedValues.map(c => VALUES.indexOf(c.value));
  const isSequence = (vIndices[0] - vIndices[1] === 1 && vIndices[1] - vIndices[2] === 1) ||
                     (vIndices[0] === 12 && vIndices[1] === 1 && vIndices[2] === 0);
  const counts = {};
  cards.forEach(c => counts[c.value] = (counts[c.value] || 0) + 1);
  const maxCount = Math.max(...Object.values(counts));
  if (maxCount === 3)            return { label: 'Trail' };
  if (isFlush && isSequence)     return { label: 'Pure Sequence' };
  if (isSequence)                return { label: 'Sequence' };
  if (isFlush)                   return { label: 'Color' };
  if (maxCount === 2)            return { label: 'Pair' };
  return { label: 'High Card' };
};

/**
 * Teen Patti (multiplayer).
 *
 * Props:
 *   roomId        — the broadcast room's id. Required to attach to the
 *                   room's shared round.
 *   myDiamonds    — controlled balance state from the host screen.
 *   setMyDiamonds — counterpart setter.
 *   onBack/onClose — navigation handlers.
 *
 * State model:
 *   The round itself lives on the server (public.game_rounds, one row
 *   per room per game). Every other user's bets show up as inserts on
 *   public.game_round_bets, which we read live via realtime. We derive
 *   - pots (per-position aggregate) from the bet rows
 *   - myBets (per-position my-share) from the same rows
 *   - timeLeft from the server's ends_at field
 *   That's why this file no longer has a local `bets`, `pots`, or
 *   `timeLeft` source-of-truth — they'd contradict the server.
 */
export default function TeenPatti({ roomId, myDiamonds, setMyDiamonds, onBack, onClose }) {
  const { user } = useGlobalState();
  // Responsive card sizing. The chair row is 3 hand-boxes, each 31% of
  // the table width with 3 cards inside. Old code had FIXED card width
  // of 34px, which works on a 360+px wide table but overflows on smaller
  // screens — the 3 cards (108px) escape the 31%-wide handBox (99px on
  // 320px wide table) and visually merge with the neighbour chair's
  // cards, producing the "9 cards in one row" rendering bug users
  // reported. We derive the size from actual table width so it scales.
  const { width: screenW } = useWindowDimensions();
  // Modal has 16px horizontal padding on each side, then tableInner has
  // its own padding too — net usable for the 3 hand-boxes is ~screenW-48.
  const handBoxW = Math.floor((screenW - 48) * 0.31);
  // 3 cards + 2px margin per card = (3 × cardW) + 6. Solve for cardW.
  const cardW = Math.max(20, Math.min(34, Math.floor((handBoxW - 6) / 3)));
  const cardH = Math.round(cardW * 1.47); // 50/34 aspect ratio preserved

  const [roundId, setRoundId]     = useState(null);
  const [endsAt, setEndsAt]       = useState(null);
  const [status, setStatus]       = useState('idle'); // idle | betting | resolving | settled
  const [winnerPos, setWinnerPos] = useState(null);
  const [betRows, setBetRows]     = useState([]);     // all bets for the current round
  const [history, setHistory]     = useState([]);
  const [hands, setHands]         = useState({ A: [], B: [], C: [] });
  const [selectedChip, setSelectedChip] = useState(1000);
  // Live multiplier from public.game_settings (mig 84 = 2.9x; was 2x
  // before). Fetched on mount + subscribed to realtime updates so a
  // future admin re-tune is reflected without an APK rebuild. Mirrors
  // the same pattern FruitRoulette.js uses for multipliersByType.
  const [teenPattiMultiplier, setTeenPattiMultiplier] = useState(2.9);
  const [showHistory, setShowHistory]   = useState(false);
  const [showHelp, setShowHelp]         = useState(false);
  const [resultMessage, setResultMessage] = useState(null);
  const [timeLeft, setTimeLeft] = useState(0);
  // Client-clock offset relative to the server. Captured the first
  // time we receive a fresh round (started_at) and reused for every
  // subsequent timer tick — so users with a fast / slow phone clock
  // still see the SAME countdown as everyone else in the room.
  // Includes a small one-way network latency component, which is
  // acceptable at the second-resolution granularity we render.
  const [clockOffsetMs, setClockOffsetMs] = useState(null);

  const flipAnims  = useRef([new Animated.Value(0), new Animated.Value(0), new Animated.Value(0)]).current;
  // Server-authoritative payout for THIS user this round, captured
  // from the resolve RPC's return JSON. Banner prefers this over
  // a client-side recompute so multi-bet winners see the correct
  // total (instead of just first row × multiplier).
  const serverWinAmountRef = useRef(null);
  // State mirror of serverWinAmountRef so a late-arriving resolve
  // response (the very common slow-network case where the first
  // resolve returns pending:true and the retry only succeeds after
  // status has already flipped to 'settled' via realtime) can
  // trigger a banner re-render with the authoritative payout.
  const [serverWinAmount, setServerWinAmount] = useState(null);
  // Animation has already played for this round, so a re-run of the
  // settle effect (triggered by a late serverWinAmount arriving) only
  // recomputes the banner text and does NOT replay the card reveal.
  const settleAnimRanRef = useRef(false);
  // Hard cap on resolve-RPC retry attempts so a network outage during
  // the resolve window can't lock the table in "REVEALING…" forever.
  // Reset by openRound() at every fresh round.
  const resolveAttemptsRef = useRef(0);
  // Next-round auto-open timer. Kept on a ref so the settle effect's
  // cleanup (which re-runs every time serverWinAmount lands late)
  // does NOT clearTimeout and re-schedule — that race let flaky
  // networks reset the 4.2s clock indefinitely and the table sat
  // on "RESULT" forever.
  const nextRoundTimerRef = useRef(null);
  // Live mirrors of status / roundId so the next-round scheduler can
  // sanity-check it's still on the round it was scheduled for before
  // calling openRound, and so the retry-loop interval can read the
  // latest status without re-subscribing on every status change.
  const statusRef  = useRef(status);
  const roundIdRef = useRef(roundId);
  statusRef.current  = status;
  roundIdRef.current = roundId;


  // ── 1. Open / attach to the room's active round ─────────────────────
  const openRound = async () => {
    if (!roomId) return;
    try {
      // `let` so the viewer-fallback below can reassign on RPC failure.
      let { data, error } = await supabase.rpc('start_game_round', {
        p_room_id:    roomId,
        p_game_type:  'teen_patti',
        p_duration_s: 30,
      });
      if (error || !data?.success) {
        // Viewer fallback — non-host clients can't call start_game_round
        // (host-only RPC) but they CAN read the room's active round so
        // the header doesn't sit on "CONNECTING…" indefinitely.
        try {
          const { data: existing } = await supabase
            .from('game_rounds')
            .select('id, ends_at, status, winner_pos, started_at')
            .eq('room_id', roomId)
            .eq('game_type', 'teen_patti')
            .in('status', ['betting', 'resolving', 'settled'])
            .order('started_at', { ascending: false })
            .limit(1)
            .maybeSingle();
          if (existing?.id) {
            data = {
              success: true,
              round_id: existing.id,
              ends_at:  existing.ends_at,
              status:   existing.status,
              winner_pos: existing.winner_pos,
              started_at: existing.started_at,
              server_now: null,
              reused: true,
            };
          } else {
            Alert.alert('Game unavailable', data?.message || error?.message || 'Could not start a round.');
            return;
          }
        } catch (_) {
          Alert.alert('Game unavailable', data?.message || error?.message || 'Could not start a round.');
          return;
        }
      }
      setRoundId(data.round_id);
      roundIdRef.current = data.round_id;
      setEndsAt(data.ends_at);
      setStatus(data.status);
      setBetRows([]);
      setWinnerPos(null);
      setResultMessage(null);
      setHands({ A: [], B: [], C: [] });
      flipAnims.forEach(a => a.setValue(0));
      serverWinAmountRef.current = null;
      resolveAttemptsRef.current = 0;
      setServerWinAmount(null);
      settleAnimRanRef.current = false;
      if (nextRoundTimerRef.current) {
        clearTimeout(nextRoundTimerRef.current);
        nextRoundTimerRef.current = null;
      }
      // Capture clock skew from server's NOW() (migration 77 adds
      // `server_now` to every response, fresh and reused). Previously
      // we used `started_at` which is correct for FRESH rounds but
      // minutes-old for REUSED rounds — a viewer joining mid-round
      // ended up with a totally wrong offset, the countdown ticked
      // out of sync, and resolve_game_round either fired too early
      // (round got stuck at 0:00) or too late (bets bounced with
      // "Betting window closed"). Using server_now keeps every
      // device in lockstep regardless of when they joined.
      if (data.server_now) {
        setClockOffsetMs(Date.now() - new Date(data.server_now).getTime());
      } else if (!data.reused && data.started_at) {
        // Backwards-compat: if the migration hasn't run yet, fall
        // back to the fresh-round-only heuristic.
        setClockOffsetMs(Date.now() - new Date(data.started_at).getTime());
      } else {
        // No fresh time signal (viewer-fallback synthesized payload, or
        // older server build). Null out the offset so timer-tick and
        // resolve-trigger gates wait for the NEXT openRound rather than
        // computing on a stale value left over from a previous round.
        setClockOffsetMs(null);
      }
      // Late-joiner: if we attached to an already-settled round, fire
      // resolve once so the already_settled branch returns winner_pos
      // + my_win_amount and the banner can render. No-op for fresh
      // rounds because they hit the betting branch.
      if (data.status === 'settled') {
        triggerResolve(data.round_id);
      }
    } catch (e) {
      Alert.alert('Network', 'Could not reach the server.');
    }
  };

  // Kick off on mount + whenever the parent passes a fresh roomId.
  useEffect(() => {
    openRound();
    // Recent round history — just for the colour dots panel.
    // The `cancelled` flag stops the late setHistory if the user opens
    // and closes the game rapidly (e.g. tap-spamming). Previously each
    // mount fired its own fetch with no cancellation, so 5 quick opens
    // = 5 concurrent queries + a setHistory race where the slowest
    // result won.
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from('game_rounds')
        .select('winner_pos')
        .eq('room_id', roomId)
        .eq('game_type', 'teen_patti')
        .eq('status', 'settled')
        .order('started_at', { ascending: false })
        .limit(10);
      if (cancelled) return;
      setHistory((data || []).map(r => r.winner_pos).filter(Boolean));
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId]);

  // Live multiplier sync — same pattern FruitRoulette.js uses. Fetch on
  // mount, subscribe to UPDATE events on the teen_patti row so an admin
  // tweak from /settings propagates to every open phone within ~1s.
  useEffect(() => {
    let cancelled = false;
    const apply = (row) => {
      const m = Number(row?.multipliers?.win);
      if (cancelled) return;
      if (Number.isFinite(m) && m > 0) setTeenPattiMultiplier(m);
    };
    (async () => {
      const { data } = await supabase
        .from('game_settings')
        .select('multipliers')
        .eq('id', 'teen_patti')
        .maybeSingle();
      if (data) apply(data);
    })();
    const ch = supabase
      .channel(`tp-settings-${Date.now()}`)
      .on('postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'game_settings', filter: 'id=eq.teen_patti' },
        (payload) => apply(payload.new))
      .subscribe();
    return () => { cancelled = true; try { supabase.removeChannel(ch); } catch (_) {} };
  }, []);

  // ── 2. Realtime subscriptions for this round ────────────────────────
  useEffect(() => {
    if (!roundId) return undefined;
    const ch = supabase
      // Date.now() suffix so a rapid round-flip doesn't get the
      // previous channel instance handed back by supabase-js (it
      // caches by name) before the old one's async removeChannel
      // has resolved, which silently dropped subsequent .on() reg.
      .channel(`tp-${roundId}-${Date.now()}`)
      .on('postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'game_rounds', filter: `id=eq.${roundId}` },
        (payload) => {
          const r = payload.new;
          setStatus(r.status);
          setEndsAt(r.ends_at);
          if (r.status === 'settled' && r.winner_pos) {
            setWinnerPos(r.winner_pos);
          }
        }
      )
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'game_round_bets', filter: `round_id=eq.${roundId}` },
        (payload) => {
          setBetRows((cur) => {
            // If we placed this bet optimistically, replace the temp
            // row with the authoritative one rather than appending a
            // duplicate. Match by user + position + amount so two
            // identical-shape bets from the same user resolve in
            // FIFO order (first temp gets replaced first).
            const tempIdx = cur.findIndex((r) =>
              r._optimistic &&
              r.user_id === payload.new.user_id &&
              r.position === payload.new.position &&
              Number(r.amount) === Number(payload.new.amount)
            );
            if (tempIdx >= 0) {
              const next = cur.slice();
              next[tempIdx] = payload.new;
              return next;
            }
            // Dedupe by real id — the same INSERT echo can arrive twice
            // in edge cases (channel reconnect mid-fire).
            if (cur.some((r) => r.id === payload.new.id)) return cur;
            return [...cur, payload.new];
          });
        }
      )
      .subscribe();
    return () => { try { supabase.removeChannel(ch); } catch (_) {} };
  }, [roundId]);

  // Backfill any bets that landed before subscription was alive.
  // Preserve any in-flight optimistic rows (a bet placed while the
  // round was opening) — otherwise the backfill would wipe out the
  // chip the user just saw land on their chair.
  useEffect(() => {
    if (!roundId) return;
    (async () => {
      const { data } = await supabase
        .from('game_round_bets')
        .select('id, user_id, position, amount')
        .eq('round_id', roundId);
      if (data) {
        setBetRows((cur) => {
          const optimistic = cur.filter((r) => r._optimistic);
          return [...data, ...optimistic];
        });
      }
    })();
  }, [roundId]);

  // ── 3. Timer derived from server's ends_at (clock-skew adjusted) ──
  useEffect(() => {
    if (status !== 'betting' || !endsAt || clockOffsetMs === null) { setTimeLeft(0); return undefined; }
    const tick = () => {
      // Estimate the server's "now" by subtracting our captured client
      // offset from local Date.now(). This way phones with skewed
      // clocks (NTP drift, manual time changes) display the same
      // countdown as everyone else in the room.
      const serverNow = Date.now() - clockOffsetMs;
      const ms = new Date(endsAt).getTime() - serverNow;
      setTimeLeft(Math.max(0, Math.ceil(ms / 1000)));
    };
    tick();
    const t = setInterval(tick, 250);
    return () => clearInterval(t);
  }, [status, endsAt, clockOffsetMs]);

  // ── 4. When the betting window closes, ANY client may resolve. The
  //       RPC is race-safe (atomic UPDATE) so duplicate calls are
  //       harmless and late callers get the same authoritative result.
  //
  //       Failure mode we defend against: every viewer in the room
  //       has a skewed clock and they all fire resolve EARLY. The
  //       server rejects the atomic claim (`ends_at <= NOW()` fails)
  //       and the round sits in 'betting' state past its expiry.
  //       Nobody ever calls resolve at the right moment, so the
  //       round stays stuck at 0:00 forever. Migration 77 fixes
  //       the offset capture so this almost never happens, but we
  //       also keep retrying every 2s while we're still 'betting'
  //       with the timer past 0 — belt and braces.
  useEffect(() => {
    if (status !== 'betting' || !endsAt || !roundId || clockOffsetMs === null) return undefined;
    const serverNow = Date.now() - clockOffsetMs;
    const ms = new Date(endsAt).getTime() - serverNow;
    let initialTimer = null;
    let retryTimer  = null;
    const startRetryLoop = () => {
      retryTimer = setInterval(() => {
        // Stop the loop the moment local status flips to settled OR
        // we've exceeded the retry budget — without this guard, a
        // transient network error in the catch below traps the user
        // forever (banner stuck at "REVEALING…").
        if (statusRef.current === 'settled' || resolveAttemptsRef.current >= 8) {
          clearInterval(retryTimer);
          retryTimer = null;
          return;
        }
        resolveAttemptsRef.current += 1;
        triggerResolve(roundId);
      }, 2000);
    };
    if (ms > 0) {
      initialTimer = setTimeout(() => {
        triggerResolve(roundId);
        startRetryLoop();
      }, ms + 200);
    } else {
      triggerResolve(roundId);
      startRetryLoop();
    }
    return () => {
      if (initialTimer) clearTimeout(initialTimer);
      if (retryTimer)   clearInterval(retryTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, endsAt, roundId, clockOffsetMs]);

  const triggerResolve = async (id) => {
    try {
      const { data } = await supabase.rpc('resolve_game_round', { p_round_id: id });
      // Self-heal path: if the realtime UPDATE event is filtered out by
      // an RLS gap (the exact bug fixed by migration 79), the RPC's
      // own return value still tells us the truth. When it carries
      // `already_settled` or `winner_pos`, drive the UI off that
      // directly instead of waiting forever for an event that will
      // never arrive.
      if (data?.success && (data.already_settled || data.winner_pos)) {
        const wp = data.winner_pos || data.result?.winner_pos;
        if (wp) setWinnerPos(wp);
        setStatus('settled');
      }
      // Capture my_win_amount for the WON banner. Wallet credit
      // itself is delegated to the global profiles realtime UPDATE
      // (server resolver already does `UPDATE profiles SET diamonds
      // = diamonds + payout`). The earlier "absolute target"
      // optimistic credit double-credited when the user had placed
      // bets during the round — the snapshot was captured at the
      // wrong moment. Trusting realtime exclusively is slightly
      // less snappy but always numerically correct.
      if (data?.success && typeof data.my_win_amount === 'number') {
        const v = Number(data.my_win_amount);
        serverWinAmountRef.current = v;
        setServerWinAmount(v);
      }
    } catch (_) {
      // Bubble up to the retry-loop guard — the loop's
      // resolveAttemptsRef + statusRef checks will stop the
      // loop after 8 attempts. We don't surface an alert here
      // because the loop is the right place to bail.
    }
  };

  // ── 5. When the round settles, run the reveal animation + payout
  //       message, then auto-open the next round after a beat.
  useEffect(() => {
    if (status !== 'settled' || !winnerPos) return;
    if (!settleAnimRanRef.current) {
      settleAnimRanRef.current = true;
      // Seed the shuffle from the round id so every viewer of the
      // same round sees identical card faces.
      const rng = mulberry32(hashStringToInt(String(roundId || 'round')));
      const deck = [];
      SUITS.forEach(s => VALUES.forEach(v => deck.push({ suit: s, value: v })));
      for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
      }
      setHands({ A: [deck[0], deck[1], deck[2]], B: [deck[3], deck[4], deck[5]], C: [deck[6], deck[7], deck[8]] });
      Animated.stagger(180, flipAnims.map(a => Animated.timing(a, {
        toValue: 1, duration: 700, useNativeDriver: true,
      }))).start();
      setHistory((prev) => [winnerPos, ...prev].slice(0, 10));
    }

    // Compute my net for the message.
    const myStakes = betRows.filter(b => b.user_id === user?.id);
    const myWinTotal = myStakes
      .filter(b => b.position === winnerPos)
      .reduce((a, b) => a + Number(b.amount || 0), 0);
    const myTotal = myStakes.reduce((a, b) => a + Number(b.amount || 0), 0);
    const myLoss  = myTotal - myWinTotal;
    if (myWinTotal > 0) {
      // Match the server multiplier (mig 84 = 2.9, fetched live from
      // game_settings above so admin re-tunes don't need a new APK).
      // The product can be fractional; round before display so we
      // don't show "+289.9999 💎".
      const payout = serverWinAmount != null
        ? Number(serverWinAmount)
        : (serverWinAmountRef.current != null
            ? Number(serverWinAmountRef.current)
            : Math.round(myWinTotal * teenPattiMultiplier));
      setResultMessage(`YOU WON +${payout.toLocaleString()} 💎`);
    } else if (myLoss > 0) {
      setResultMessage(`YOU LOST -${myLoss.toLocaleString()} 💎`);
    } else {
      setResultMessage('ROUND OVER');
    }

    // Schedule the next round on a dedicated ref. Lives OUTSIDE the
    // settleAnimRanRef-guarded block and is NOT cleaned up by this
    // effect's cleanup — a late serverWinAmount arriving after settle
    // re-runs this effect, and previously the inline `clearTimeout(t)`
    // killed the scheduled openRound so the table sat on "RESULT"
    // forever on flaky networks.
    if (!nextRoundTimerRef.current) {
      const scheduledForRound = roundIdRef.current;
      nextRoundTimerRef.current = setTimeout(() => {
        nextRoundTimerRef.current = null;
        if (statusRef.current === 'settled' && roundIdRef.current === scheduledForRound) {
          openRound();
        }
      }, 4200);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, winnerPos, serverWinAmount]);

  // Unmount safety — clear the next-round auto-open timer so closing
  // the game mid-settle doesn't fire openRound after we're gone.
  useEffect(() => () => {
    if (nextRoundTimerRef.current) {
      clearTimeout(nextRoundTimerRef.current);
      nextRoundTimerRef.current = null;
    }
  }, []);

  // ── 6. Derived view models ──────────────────────────────────────────
  const pots = useMemo(() => {
    const acc = { A: 0, B: 0, C: 0 };
    betRows.forEach((b) => { acc[b.position] = (acc[b.position] || 0) + Number(b.amount || 0); });
    return acc;
  }, [betRows]);

  const myBets = useMemo(() => {
    const acc = { A: 0, B: 0, C: 0 };
    betRows.filter(b => b.user_id === user?.id).forEach((b) => {
      acc[b.position] = (acc[b.position] || 0) + Number(b.amount || 0);
    });
    return acc;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [betRows, user?.id]);

  // ── 7. Place a bet (server-validated, optimistic UI) ───────────────
  // Fire-and-forget the RPC so a user tapping fast isn't gated on the
  // network round-trip. Each tap gets its own tempId; rollback on
  // failure targets that specific id so other in-flight bets stay put.
  // Server-side `place_game_bet` inserts a new row per call (each bet
  // is its own game_round_bets record) so concurrent in-flight calls
  // are safe — no dedup race.
  const handlePlaceBet = (pos) => {
    if (status !== 'betting' || !roundId) return;
    if (myDiamonds < selectedChip) {
      Alert.alert('Insufficient Diamonds', `You need at least ${selectedChip.toLocaleString()} 💎.`);
      return;
    }

    const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const optimisticRow = {
      id:        tempId,
      round_id:  roundId,
      user_id:   user?.id,
      position:  pos,
      amount:    selectedChip,
      win_amount: 0,
      created_at: new Date().toISOString(),
      _optimistic: true,
    };
    setBetRows((cur) => [...cur, optimisticRow]);
    setMyDiamonds((prev) => Math.max(0, prev - selectedChip));

    (async () => {
      try {
        const { data, error } = await supabase.rpc('place_game_bet', {
          p_round_id: roundId,
          p_position: pos,
          p_amount:   selectedChip,
        });
        if (error || !data?.success) {
          setBetRows((cur) => cur.filter((r) => r.id !== tempId));
          setMyDiamonds((prev) => prev + selectedChip);
          Alert.alert('Bet failed', data?.message || error?.message || 'Could not place bet.');
        }
      } catch (e) {
        setBetRows((cur) => cur.filter((r) => r.id !== tempId));
        setMyDiamonds((prev) => prev + selectedChip);
        Alert.alert('Bet failed', e?.message || 'Network error.');
      }
    })();
  };

  // ── 8. Card render (visual only) ────────────────────────────────────
  const renderCard = (card, anim, index) => {
    const frontRotateY = anim.interpolate({ inputRange: [0, 1], outputRange: ['180deg', '0deg'] });
    const backRotateY  = anim.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '-180deg'] });
    return (
      <View key={index} style={[styles.cardWrapper, { width: cardW, height: cardH }]}>
        <Animated.View style={[styles.card, styles.cardAbsolute, { width: cardW, height: cardH, transform: [{ rotateY: backRotateY }] }]}>
          <Image source={require('../../../assets/images/card_back.webp')} style={styles.cardBackImage} />
        </Animated.View>
        <Animated.View style={[styles.card, { width: cardW, height: cardH, transform: [{ rotateY: frontRotateY }] }]}>
          <Text style={[styles.cardVal, { color: (card.suit === '♥' || card.suit === '♦') ? '#EF4444' : '#000' }]}>
            {card.value}{card.suit}
          </Text>
        </Animated.View>
      </View>
    );
  };

  const headerStatusText =
    status === 'betting'   ? `BETTING ${timeLeft}s` :
    status === 'resolving' ? 'REVEALING…' :
    status === 'settled'   ? 'RESULT' : 'CONNECTING…';

  return (
    <View style={styles.outerContainer}>
      {/* Header */}
      <View style={styles.gameHeader}>
        <View style={styles.headerLeft}>
          <TouchableOpacity onPress={onBack} style={styles.backBtn}>
            <Ionicons name="chevron-back" size={24} color="#FFF" />
          </TouchableOpacity>
          <View>
            <Text style={styles.gameTitleText}>Teen Patti Live</Text>
            <Text style={styles.balanceText}>💎 {myDiamonds.toLocaleString()}</Text>
          </View>
        </View>

        <View style={[styles.timerContainer, status !== 'betting' && { backgroundColor: 'rgba(251,191,36,0.18)' }]}>
          <Text style={styles.timerVal}>{headerStatusText}</Text>
        </View>

        <View style={styles.headerRight}>
          <TouchableOpacity onPress={() => setShowHelp(true)} style={styles.headerIconBtn}>
            <Ionicons name="help-circle-outline" size={20} color="rgba(255,255,255,0.7)" />
          </TouchableOpacity>
          <TouchableOpacity onPress={onClose} style={[styles.headerIconBtn, { marginLeft: 8 }]}>
            <Ionicons name="close" size={20} color="rgba(255,255,255,0.5)" />
          </TouchableOpacity>
        </View>
      </View>

      {/* Table */}
      <LinearGradient colors={['#2A1B4E', '#160F29']} style={styles.tableInner}>
        <View style={styles.handsContainer}>
          {POSITIONS.map((pos, idx) => {
            const handRank = hands[pos].length > 0 ? getHandRank(hands[pos]) : null;
            const isWinner = winnerPos === pos;
            const isLoser  = winnerPos !== null && winnerPos !== pos;
            return (
              <View key={pos} style={[styles.handBox, isLoser && { opacity: 0.25 }]}>
                <View style={[styles.cardsRow, { height: cardH }]}>
                  {hands[pos].length > 0 ? (
                    hands[pos].map((card, cIdx) => renderCard(card, flipAnims[idx], cIdx))
                  ) : (
                    [0,1,2].map(i => (
                      <View key={i} style={[styles.cardWrapper, { width: cardW, height: cardH }]}>
                        <View style={[styles.cardBackPlaceholder, { width: cardW, height: cardH }]}>
                          <Image source={require('../../../assets/images/card_back.webp')} style={styles.cardBackImage} />
                        </View>
                      </View>
                    ))
                  )}
                </View>

                {handRank && status !== 'betting' && (
                  <View style={[styles.rankBadge, isWinner && styles.winnerBadge]}>
                    <Text style={styles.rankText}>{handRank.label}</Text>
                  </View>
                )}

                <View style={styles.posVisual}>
                  <View style={styles.royalChairContainer}>
                    <MaterialCommunityIcons
                      name="chair-rolling"
                      size={55}
                      color={POS_COLOR[pos]}
                      style={{ opacity: isWinner ? 1 : 0.7 }}
                    />
                  </View>
                  {isWinner && <View style={styles.winnerGlow} />}
                </View>

                <TouchableOpacity
                  style={[styles.betSlot, isWinner && styles.betSlotWinner]}
                  onPress={() => handlePlaceBet(pos)}
                  disabled={status !== 'betting'}
                >
                  <Text style={styles.slotLabel}>{pos}</Text>
                  <Text style={styles.slotPot}>Pot: {formatCompactNumber(pots[pos] || 0)}</Text>
                  {myBets[pos] > 0 && (
                    <View style={styles.myBetBadge}>
                      <Text style={styles.myBetText}>{formatCompactNumber(myBets[pos])}</Text>
                    </View>
                  )}
                </TouchableOpacity>
              </View>
            );
          })}
        </View>

        {resultMessage && (
          <View style={[
            styles.resultBanner,
            { backgroundColor: resultMessage.includes('WON') ? '#22C55E' : (resultMessage.includes('LOST') ? '#EF4444' : BRAND.primary) },
          ]}>
            <Text style={styles.resultMsgText}>{resultMessage}</Text>
          </View>
        )}
      </LinearGradient>

      {/* Footer */}
      <View style={styles.footer}>
        <View style={styles.chipsSection}>
          <View style={styles.chipTrack}>
            {CHIP_VALUES.map((val) => {
              const tooRich = val > (myDiamonds || 0);
              return (
                <TouchableOpacity
                  key={val}
                  style={[
                    styles.miniChip,
                    selectedChip === val && styles.miniChipActive,
                    tooRich && { opacity: 0.35 },
                  ]}
                  disabled={tooRich}
                  onPress={() => setSelectedChip(val)}
                >
                  <Text style={styles.miniChipText}>{formatCompactNumber(val)}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
          <TouchableOpacity style={styles.historyBtn} onPress={() => setShowHistory(true)}>
            <Ionicons name="time-outline" size={22} color="#FBBF24" />
          </TouchableOpacity>
        </View>
      </View>

      {/* History */}
      <Modal transparent visible={showHistory} animationType="fade">
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={() => setShowHistory(false)}>
          <View style={styles.historyCard}>
            <Text style={styles.historyTitle}>Winning History</Text>
            <View style={styles.historyGrid}>
              {history.map((win, i) => (
                <View key={i} style={[styles.histCircle, { backgroundColor: POS_COLOR[win] || '#666' }]}>
                  <Text style={styles.histText}>{win}</Text>
                </View>
              ))}
              {history.length === 0 && <Text style={{ color: 'rgba(255,255,255,0.5)' }}>No rounds yet.</Text>}
            </View>
            <TouchableOpacity style={styles.closeModalBtn} onPress={() => setShowHistory(false)}>
              <Text style={styles.closeModalText}>Close</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* Help */}
      <Modal transparent visible={showHelp} animationType="fade">
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={() => setShowHelp(false)}>
          <View style={styles.helpCard}>
            <View style={styles.helpHeader}>
              <Ionicons name="information-circle" size={24} color="#FBBF24" />
              <Text style={styles.helpTitle}>Teen Patti Rules</Text>
            </View>
            <ScrollView showsVerticalScrollIndicator={false} style={{ width: '100%', maxHeight: 300 }}>
              <View style={styles.ruleItem}><Text style={styles.ruleLabel}>🃏 Trail:</Text><Text style={styles.ruleVal}>Three cards of the same rank.</Text></View>
              <View style={styles.ruleItem}><Text style={styles.ruleLabel}>🎴 Pure Seq:</Text><Text style={styles.ruleVal}>Three consecutive cards, same suit.</Text></View>
              <View style={styles.ruleItem}><Text style={styles.ruleLabel}>📏 Sequence:</Text><Text style={styles.ruleVal}>Three consecutive cards, mixed suits.</Text></View>
              <View style={styles.ruleItem}><Text style={styles.ruleLabel}>🎨 Color:</Text><Text style={styles.ruleVal}>Three same-suit cards not in sequence.</Text></View>
              <View style={styles.ruleItem}><Text style={styles.ruleLabel}>👯 Pair:</Text><Text style={styles.ruleVal}>Two cards of the same rank.</Text></View>
              <View style={styles.ruleItem}><Text style={styles.ruleLabel}>🔝 High Card:</Text><Text style={styles.ruleVal}>Highest single card.</Text></View>
              <View style={styles.ruleItem}><Text style={styles.ruleLabel}>👥 Multiplayer:</Text><Text style={styles.ruleVal}>Pot shows all bets in this room. Winner pays {teenPattiMultiplier}× your stake.</Text></View>
            </ScrollView>
            <TouchableOpacity style={styles.closeModalBtn} onPress={() => setShowHelp(false)}>
              <Text style={styles.closeModalText}>Got it</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  outerContainer: { backgroundColor: 'transparent', paddingHorizontal: 12, paddingVertical: 12, borderTopLeftRadius: 30, borderTopRightRadius: 30 },
  gameHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  headerLeft: { flexDirection: 'row', alignItems: 'center' },
  headerRight: { flexDirection: 'row', alignItems: 'center' },
  headerIconBtn: { width: 34, height: 34, borderRadius: 17, backgroundColor: 'rgba(255,255,255,0.06)', justifyContent: 'center', alignItems: 'center' },
  backBtn: { marginRight: 10 },
  gameTitleText: { color: '#FFF', fontSize: 13, fontWeight: 'bold' },
  balanceText: { color: '#FBBF24', fontSize: 10, fontWeight: '600' },

  timerContainer: { backgroundColor: 'rgba(255,255,255,0.08)', paddingHorizontal: 12, paddingVertical: 4, borderRadius: 20 },
  timerVal: { color: '#FFF', fontSize: 11, fontWeight: 'bold' },

  tableInner: { borderRadius: 25, padding: 12, borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)', minHeight: 280 },
  handsContainer: { flex: 1, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  // overflow: hidden guards against any small math error in the
  // responsive card-width calc — even if the cards-row slightly
  // overshoots 31%, the box clips its content so it can never bleed
  // into the neighbour chair (which is what produced the "9 cards
  // glued in one row" rendering on small phones).
  handBox: { alignItems: 'center', width: '31%', overflow: 'hidden' },

  cardsRow: { flexDirection: 'row', height: 50, marginBottom: 15 },
  cardWrapper: { width: 34, height: 50, marginHorizontal: 1 },
  card: { width: 34, height: 50, backgroundColor: '#FFF', borderRadius: 6, justifyContent: 'center', alignItems: 'center', backfaceVisibility: 'hidden' },
  cardAbsolute: { position: 'absolute', top: 0, left: 0 },
  cardBackImage: { width: '100%', height: '100%', borderRadius: 6 },
  cardBackPlaceholder: { width: 34, height: 50, backgroundColor: '#2D144A', borderRadius: 6, borderWidth: 1, borderColor: '#5B3E84', overflow: 'hidden' },
  cardVal: { fontSize: 11, fontWeight: 'bold' },

  rankBadge: { position: 'absolute', top: 40, backgroundColor: '#EF4444', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, zIndex: 10 },
  winnerBadge: { backgroundColor: '#22C55E' },
  rankText: { color: '#FFF', fontSize: 8, fontWeight: 'bold' },

  posVisual: { marginBottom: 10, justifyContent: 'center', alignItems: 'center' },
  royalChairContainer: { width: 60, height: 60, borderRadius: 30, backgroundColor: 'rgba(255,255,255,0.03)', justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)' },
  winnerGlow: { position: 'absolute', width: 70, height: 70, borderRadius: 35, backgroundColor: 'rgba(251,191,36,0.3)', zIndex: -1 },

  betSlot: { width: '100%', backgroundColor: 'rgba(255,255,255,0.05)', borderRadius: 12, paddingVertical: 8, alignItems: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)' },
  betSlotWinner: { borderColor: '#FBBF24', backgroundColor: 'rgba(251,191,36,0.1)' },
  slotLabel: { color: '#FFF', fontSize: 14, fontWeight: '900' },
  slotPot: { color: 'rgba(255,255,255,0.55)', fontSize: 9, marginTop: 2 },

  myBetBadge: { position: 'absolute', top: -10, right: -5, backgroundColor: BRAND.primary, borderRadius: 10, paddingHorizontal: 5, paddingVertical: 2, borderWidth: 1.5, borderColor: '#FFF' },
  myBetText: { color: '#FFF', fontSize: 8, fontWeight: 'bold' },

  resultBanner: { position: 'absolute', top: '7%', alignSelf: 'center', backgroundColor: BRAND.primary, paddingHorizontal: 15, paddingVertical: 6, borderRadius: 20, elevation: 10, zIndex: 100 },
  resultMsgText: { color: '#FFF', fontSize: 11, fontWeight: 'bold' },

  footer: { marginTop: 10, paddingBottom: 5 },
  chipsSection: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  chipTrack: { flexDirection: 'row', backgroundColor: 'rgba(255,255,255,0.05)', padding: 4, borderRadius: 30, gap: 6 },
  miniChip: { width: 42, height: 42, borderRadius: 21, backgroundColor: '#374151', justifyContent: 'center', alignItems: 'center', borderWidth: 2, borderColor: 'transparent' },
  miniChipActive: { borderColor: '#FBBF24', backgroundColor: BRAND.primary },
  miniChipText: { color: '#FFF', fontSize: 10, fontWeight: 'bold' },
  historyBtn: { width: 44, height: 44, borderRadius: 22, backgroundColor: 'rgba(255,255,255,0.1)', justifyContent: 'center', alignItems: 'center' },

  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.8)', justifyContent: 'center', alignItems: 'center' },
  historyCard: { backgroundColor: '#1F1147', width: '80%', borderRadius: 25, padding: 25, alignItems: 'center' },
  historyTitle: { color: '#FFF', fontSize: 18, fontWeight: 'bold', marginBottom: 20 },
  historyGrid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 10, minHeight: 36 },
  histCircle: { width: 36, height: 36, borderRadius: 18, justifyContent: 'center', alignItems: 'center' },
  histText: { color: '#FFF', fontWeight: 'bold' },
  closeModalBtn: { marginTop: 25, paddingVertical: 10, paddingHorizontal: 30, backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: 20 },
  closeModalText: { color: '#FFF', fontWeight: 'bold' },

  helpCard: { backgroundColor: '#1F1147', width: '85%', borderRadius: 25, padding: 20, alignItems: 'center' },
  helpHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 15 },
  helpTitle: { color: '#FFF', fontSize: 18, fontWeight: 'bold', marginLeft: 10 },
  ruleItem: { width: '100%', marginBottom: 12, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.05)', paddingBottom: 8 },
  ruleLabel: { color: '#FBBF24', fontSize: 13, fontWeight: 'bold', marginBottom: 2 },
  ruleVal: { color: 'rgba(255,255,255,0.7)', fontSize: 12 },
});
