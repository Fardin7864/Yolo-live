import React, { useState, useEffect, useRef, useMemo } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Modal, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { supabase } from '../../api/supabase';
import { useGlobalState } from '../../context/GlobalStateContext';
import { formatCompactNumber } from '../../utils/format';
import { BRAND } from '../../theme/brand';

// 8 unique slots arranged on a 3x3 grid (centre cell holds the spinning
// fruit emoji). The `multiplier` field is a FALLBACK only — migration 82
// (5/5/5/5/10/15/25/45) and any future re-tune lives in
// public.game_settings.multipliers, and the component reads that table
// on mount + subscribes to realtime updates so an admin re-tune is
// reflected in the UI without an APK rebuild. See `multipliersByType`
// state + the `game_settings` subscription below.
const SLOTS = [
  { id: 0, icon: '🍎', type: 'apple',      multiplier: 5,  pos: [0, 0] },
  { id: 1, icon: '🍌', type: 'banana',     multiplier: 5,  pos: [0, 1] },
  { id: 2, icon: '🍊', type: 'orange',     multiplier: 5,  pos: [0, 2] },
  { id: 3, icon: '🍉', type: 'watermelon', multiplier: 5,  pos: [1, 2] },
  { id: 4, icon: '🍇', type: 'grapes',     multiplier: 10, pos: [2, 2] },
  { id: 5, icon: '🍍', type: 'pineapple',  multiplier: 15, pos: [2, 1] },
  { id: 6, icon: '🥭', type: 'mango',      multiplier: 25, pos: [2, 0] },
  { id: 7, icon: '👑', type: 'crown',      multiplier: 45, pos: [1, 0] },
];
const TYPE_TO_SLOT = Object.fromEntries(SLOTS.map(s => [s.type, s]));
const DEFAULT_MULTIPLIERS = Object.fromEntries(SLOTS.map(s => [s.type, s.multiplier]));

const BET_AMOUNTS = [100, 1000, 10000, 100000];

/**
 * Fruit Roulette (multiplayer).
 *
 * Props:
 *   roomId        — the broadcast room's id (required for room-shared rounds)
 *   myDiamonds    — controlled balance from the host screen
 *   setMyDiamonds — counterpart setter
 *   onBack/onClose — navigation handlers
 *
 * State model mirrors TeenPatti.js: round + bets live on the server, the
 * client reads them via Supabase realtime and renders. Timer ticks down
 * from `ends_at`. When the betting window closes, any client can call
 * `resolve_game_round` — first caller wins the race and broadcasts the
 * authoritative winner to every other client through the round UPDATE.
 */
export default function FruitRoulette({ roomId, myDiamonds, setMyDiamonds, onBack, onClose }) {
  const { user } = useGlobalState();

  const [roundId, setRoundId]       = useState(null);
  const [endsAt, setEndsAt]         = useState(null);
  const [status, setStatus]         = useState('idle');
  const [winnerType, setWinnerType] = useState(null);
  const [winnerSlotId, setWinnerSlotId] = useState(null);
  // `revealed` gates the green winner styling. It starts FALSE the moment
  // a round flips to 'settled' and only flips TRUE when the spin animation
  // lands on the target slot. Without this gate the winner cell turns
  // green the instant Realtime delivers status='settled', spoiling the
  // spin reveal (Bug 2 reported 2026-06-15).
  const [revealed, setRevealed]     = useState(false);
  const [betRows, setBetRows]       = useState([]);
  const [timeLeft, setTimeLeft]     = useState(0);
  const [activeSlot, setActiveSlot] = useState(0);
  const [resultMessage, setResultMessage] = useState(null);
  const [selectedBet, setSelectedBet] = useState(100);
  const [showHelp, setShowHelp]     = useState(false);
  // Recent winning fruits for this room. Same UX as TeenPatti — gives
  // bettors something to glance at before they commit, even though the
  // server's RNG ignores history (no "due for crown" bias). We hold the
  // last 20 to leave a couple rows of pattern visible in the modal.
  const [history, setHistory]       = useState([]); // [{ type, icon, ts }]
  const [showHistory, setShowHistory] = useState(false);
  // Live multipliers from public.game_settings. Defaults to the
  // hard-coded SLOTS ladder so the UI never renders blank, but a fresh
  // fetch + realtime subscription below take over once data arrives.
  // This makes admin re-tunes (mig 82 and any future migration) visible
  // without an APK rebuild (Bug 1 reported 2026-06-15).
  const [multipliersByType, setMultipliersByType] = useState(DEFAULT_MULTIPLIERS);
  // Client-clock offset relative to the server. See the matching
  // comment in TeenPatti.js — same purpose: keep every phone's
  // countdown in lockstep regardless of local clock skew.
  const [clockOffsetMs, setClockOffsetMs] = useState(null);
  // State mirror of serverWinAmountRef so a late-arriving resolve
  // response (the very common slow-network case where the first
  // resolve returns pending:true and the retry only succeeds after
  // status has already flipped to 'settled' via realtime) can
  // trigger a banner re-render with the authoritative payout.
  const [serverWinAmount, setServerWinAmount] = useState(null);

  const spinTimer  = useRef(null);
  // Server-authoritative payout for THIS user this round, captured
  // from the resolve RPC's return JSON. Banner prefers this over
  // a client-side recompute so multi-bet winners see the correct
  // total (instead of just first row × multiplier).
  const serverWinAmountRef = useRef(null);
  // Spin animation has already played for this round, so a re-run of
  // the settle effect (triggered by a late serverWinAmount arriving)
  // only recomputes the banner text and does NOT replay the spin.
  const settleAnimRanRef = useRef(false);
  // Spin-start snapshot of activeSlot so a re-fire of the spin effect
  // (when winnerType arrives in a second realtime UPDATE) doesn't
  // restart the wheel from whatever the resolving-phase ticker has
  // moved activeSlot to in the meantime.
  const spinStartSlotRef = useRef(0);
  // Hard cap on resolve-RPC retry attempts so a network outage during
  // the resolve window can't lock the wheel in "Spinning…" forever.
  // Reset by openRound() at every fresh round.
  const resolveAttemptsRef = useRef(0);
  // Next-round auto-open timer — kept SEPARATE from spinTimer so the
  // settle effect's cleanup (which clears spinTimer for animation
  // cancellation) doesn't also kill the scheduled next round.
  const nextRoundTimerRef = useRef(null);
  // Live mirrors of status / roundId so the next-round scheduler can
  // sanity-check it's still on the round it was scheduled for before
  // calling openRound (Issue 4 — stale settled timer race).
  const statusRef  = useRef(status);
  const roundIdRef = useRef(roundId);
  statusRef.current  = status;
  roundIdRef.current = roundId;


  // ── 1. Open / attach to room's active round ────────────────────────
  const openRound = async () => {
    if (!roomId) return;
    try {
      let { data, error } = await supabase.rpc('start_game_round', {
        p_room_id:    roomId,
        p_game_type:  'fruit_roulette',
        p_duration_s: 30,
      });
      if (error || !data?.success) {
        // Viewer fallback (Issue 5) — non-host viewers can't start a
        // round but they CAN read the room's active round directly so
        // the "Connecting…" screen doesn't hang on a permission error.
        // Mirrors the audit's recommendation: on start_game_round
        // failure, SELECT the latest in-flight game_round for the room.
        try {
          const { data: existing } = await supabase
            .from('game_rounds')
            .select('id, ends_at, status, winner_pos, started_at')
            .eq('room_id', roomId)
            .eq('game_type', 'fruit_roulette')
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
              started_at: existing.started_at,
              winner_pos: existing.winner_pos,
              reused: true,
            };
          }
        } catch (_) {}
      }
      if (!data?.success) {
        Alert.alert('Game unavailable', data?.message || error?.message || 'Could not start a round.');
        return;
      }
      setRoundId(data.round_id);
      setEndsAt(data.ends_at);
      setStatus(data.status);
      setBetRows([]);
      setWinnerType(null);
      setWinnerSlotId(null);
      setRevealed(false);
      setResultMessage(null);
      setActiveSlot(0);
      serverWinAmountRef.current = null;
      resolveAttemptsRef.current = 0;
      setServerWinAmount(null);
      settleAnimRanRef.current = false;
      if (nextRoundTimerRef.current) {
        clearTimeout(nextRoundTimerRef.current);
        nextRoundTimerRef.current = null;
      }
      // Capture clock skew from server's NOW() (migration 77 adds
      // `server_now` to every response). Previously we only captured
      // it on FRESH rounds via `started_at`, so a viewer joining
      // mid-round (reused=true) ended up with offset=0 and a wrong
      // countdown. See migration 77 comments for the full story.
      if (data.server_now) {
        setClockOffsetMs(Date.now() - new Date(data.server_now).getTime());
      } else if (!data.reused && data.started_at) {
        setClockOffsetMs(Date.now() - new Date(data.started_at).getTime());
      } else {
        // No fresh time signal (viewer-fallback synthesized payload, or
        // older server build). Null out the offset so timer-tick and
        // resolve-trigger gates wait for the NEXT openRound rather than
        // computing on a stale value left over from a previous round.
        setClockOffsetMs(null);
      }
      if (data.status === 'settled') {
        // Late-joiner — pull the already-settled result so the banner
        // and winnerSlotId populate without waiting for the retry loop.
        try {
          const { data: r } = await supabase.rpc('resolve_game_round', { p_round_id: data.round_id });
          if (r?.success && (r.already_settled || r.winner_pos)) {
            const wp = r.winner_pos || r.result?.winner_pos;
            if (wp) {
              setWinnerType(wp);
              const wid = TYPE_TO_SLOT[wp]?.id;
              if (wid !== undefined) setWinnerSlotId(wid);
            }
            if (typeof r.my_win_amount === 'number') {
              const v = Number(r.my_win_amount);
              serverWinAmountRef.current = v;
              setServerWinAmount(v);
            }
            setStatus('settled');
          }
        } catch (_) {}
      }
    } catch (_) {
      Alert.alert('Network', 'Could not reach the server.');
    }
  };

  useEffect(() => {
    openRound();
    // Clear room-A's local history before fetching room-B's — without
    // this, _local entries from the previous room briefly leak into
    // the History modal until the fetch below resolves.
    setHistory([]);
    // Recent winning-fruit history for this room — populates the
    // history modal at mount so players see prior patterns before
    // their first round. `cancelled` guards against the late
    // setHistory winning a race if the user re-enters the game
    // rapidly. Mirrors the equivalent TeenPatti fetch.
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from('game_rounds')
        .select('winner_pos, started_at')
        .eq('room_id', roomId)
        .eq('game_type', 'fruit_roulette')
        .eq('status', 'settled')
        .order('started_at', { ascending: false })
        .limit(20);
      if (cancelled) return;
      setHistory((data || [])
        .map((r) => {
          const slot = TYPE_TO_SLOT[r.winner_pos];
          if (!slot) return null;
          return { type: r.winner_pos, icon: slot.icon, ts: r.started_at };
        })
        .filter(Boolean));
    })();
    return () => { cancelled = true; };
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [roomId]);

  // ── 2. Realtime subscriptions ──────────────────────────────────────
  useEffect(() => {
    if (!roundId) return undefined;
    const ch = supabase
      // Date.now() suffix so a rapid round-flip doesn't get the
      // previous channel instance handed back by supabase-js (it
      // caches by name) before the old one's async removeChannel
      // has resolved, which silently dropped subsequent .on() reg.
      .channel(`fr-${roundId}-${Date.now()}`)
      .on('postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'game_rounds', filter: `id=eq.${roundId}` },
        (payload) => {
          const r = payload.new;
          setStatus(r.status);
          setEndsAt(r.ends_at);
          if (r.status === 'settled' && r.winner_pos) {
            setWinnerType(r.winner_pos);
            const wid = TYPE_TO_SLOT[r.winner_pos]?.id;
            if (wid !== undefined) setWinnerSlotId(wid);
          }
        }
      )
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'game_round_bets', filter: `round_id=eq.${roundId}` },
        (payload) => {
          setBetRows((cur) => {
            // Replace any matching optimistic temp row with the real
            // INSERT — same pattern as TeenPatti. Stops duplicate
            // chips from briefly showing after a quick tap.
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
            if (cur.some((r) => r.id === payload.new.id)) return cur;
            return [...cur, payload.new];
          });
        }
      )
      .subscribe();
    return () => { try { supabase.removeChannel(ch); } catch (_) {} };
  }, [roundId]);

  // Backfill bets that landed before subscription was alive. Preserve
  // any in-flight optimistic rows so a chip the user just placed
  // doesn't briefly vanish when the backfill resolves.
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

  // ── 2b. Live multipliers from game_settings (Bug 1 — 2026-06-15) ──
  // Pulls the row once on mount and listens for realtime UPDATE events
  // (game_settings is already in the supabase_realtime publication, see
  // mig 42). The render code derives every cell's multiplier label, and
  // the per-tile pot / WON message use these values, so an admin retune
  // is visible the instant the row changes — no APK rebuild.
  useEffect(() => {
    let cancelled = false;
    const applyRow = (row) => {
      if (cancelled || !row) return;
      const arr = Array.isArray(row.multipliers) ? row.multipliers
                : (typeof row.multipliers === 'string'
                    ? (() => { try { return JSON.parse(row.multipliers); } catch (_) { return null; } })()
                    : null);
      if (!arr || !Array.isArray(arr)) return;
      const next = { ...DEFAULT_MULTIPLIERS };
      arr.forEach((s) => {
        if (s && typeof s.type === 'string' && typeof s.m === 'number') {
          next[s.type] = s.m;
        }
      });
      setMultipliersByType(next);
    };
    (async () => {
      const { data } = await supabase
        .from('game_settings')
        .select('multipliers')
        .eq('id', 'fruit_roulette')
        .maybeSingle();
      applyRow(data);
    })();
    const ch = supabase
      .channel(`fr-settings-${Date.now()}`)
      .on('postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'game_settings', filter: 'id=eq.fruit_roulette' },
        (payload) => applyRow(payload.new)
      )
      .subscribe();
    return () => {
      cancelled = true;
      try { supabase.removeChannel(ch); } catch (_) {}
    };
  }, []);

  // ── 3. Timer derived from server's ends_at (clock-skew adjusted) ──
  useEffect(() => {
    if (status !== 'betting' || !endsAt || clockOffsetMs === null) { setTimeLeft(0); return undefined; }
    const tick = () => {
      // Use the offset-corrected server clock so every viewer in the
      // room shows the same countdown second regardless of how skewed
      // their local time is.
      const serverNow = Date.now() - clockOffsetMs;
      const ms = new Date(endsAt).getTime() - serverNow;
      setTimeLeft(Math.max(0, Math.ceil(ms / 1000)));
    };
    tick();
    const t = setInterval(tick, 250);
    return () => clearInterval(t);
  }, [status, endsAt, clockOffsetMs]);

  // ── 4. Auto-trigger resolve when the betting window closes ─────────
  // Safety net: if every viewer's clock is skewed AHEAD, they all
  // fire resolve too early, the server rejects the atomic claim, and
  // the round sits stuck at 0:00 forever. After the initial fire we
  // keep retrying every 2s while still in 'betting' status — one of
  // them will eventually land past the real server expiry. Cleanup
  // clears both timers when the effect re-runs (status flips out of
  // 'betting').
  useEffect(() => {
    if (status !== 'betting' || !endsAt || !roundId || clockOffsetMs === null) return undefined;
    const serverNow = Date.now() - clockOffsetMs;
    const ms = new Date(endsAt).getTime() - serverNow;
    const fire = async () => {
      try {
        const { data } = await supabase.rpc('resolve_game_round', { p_round_id: roundId });
        // Self-heal: if Realtime drops the UPDATE event for any
        // reason (RLS gap, channel reconnect mid-flip), the RPC
        // return value still tells us the winner. Drive the UI
        // directly off it.
        if (data?.success && (data.already_settled || data.winner_pos)) {
          const wp = data.winner_pos || data.result?.winner_pos;
          if (wp) {
            setWinnerType(wp);
            const wid = TYPE_TO_SLOT[wp]?.id;
            if (wid !== undefined) setWinnerSlotId(wid);
          }
          // Bug 3 (2026-06-15) — credit the local balance off the RPC
          // return value. Server already credited the row via
          // resolve_game_round → UPDATE profiles SET diamonds = +. The
          // global profile-row realtime subscription should ALSO catch
          // the change, but on slow phones / spotty connections that
          // event sometimes lands after the user has left the result
          // screen. The optimistic add here is bounded by
          // data.my_win_amount which the server already wrote into
          // game_round_bets.win_amount, so even on retry (which returns
          // already_settled=true plus the same my_win_amount) we add
          // once per render of this effect — and the realtime
          // n.diamonds overwrite is authoritative so any race
          // converges.
          if (typeof data.my_win_amount === 'number') {
            const v = Number(data.my_win_amount);
            serverWinAmountRef.current = v;
            setServerWinAmount(v);
          }
          // Wallet credit is fully delegated to the global profiles
          // realtime UPDATE — the server-side resolver already does
          // `UPDATE profiles SET diamonds = diamonds + payout` and
          // Supabase realtime pushes the authoritative value to
          // this client within a few hundred ms. The previous
          // local-credit path drifted out of sync for any user who
          // had placed bets during the round (snapshot captured at
          // the wrong moment double-credited or under-credited
          // depending on race ordering with the realtime event).
          // Trusting realtime exclusively is slightly less snappy
          // but always numerically correct. The serverWinAmount
          // captured above still drives the WON banner instantly,
          // so the user gets immediate confirmation of the amount
          // even before the wallet pill ticks up.
          setStatus('settled');
        }
      } catch (_) {}
    };
    let initialTimer = null;
    let retryTimer  = null;
    const startRetryLoop = () => {
      retryTimer = setInterval(() => {
        // Bail when local status flips to settled OR we've burned the
        // retry budget — without this guard a transient network error
        // here trapped the wheel on "Spinning…" forever.
        if (statusRef.current === 'settled' || resolveAttemptsRef.current >= 8) {
          clearInterval(retryTimer);
          retryTimer = null;
          return;
        }
        resolveAttemptsRef.current += 1;
        fire();
      }, 2000);
    };
    if (ms > 0) {
      initialTimer = setTimeout(() => { fire(); startRetryLoop(); }, ms + 200);
    } else {
      fire();
      startRetryLoop();
    }
    return () => {
      if (initialTimer) clearTimeout(initialTimer);
      if (retryTimer)   clearInterval(retryTimer);
    };
  }, [status, endsAt, roundId, clockOffsetMs]);

  // ── 5. When the round settles, run the spin animation to the winning
  //       slot, then show result and open the next round.
  useEffect(() => {
    if (status !== 'settled' || winnerSlotId === null) return undefined;

    // Compute the banner text — runs on every effect re-run so a
    // late-arriving serverWinAmount can correct it without restarting
    // the spin. Uses state-preferred payout (state → ref → recompute).
    const computeBanner = () => {
      const myStakes = betRows.filter(b => b.user_id === user?.id);
      const myWinTotal = myStakes
        .filter(b => b.position === winnerType)
        .reduce((a, b) => a + Number(b.amount || 0), 0);
      const myTotal = myStakes.reduce((a, b) => a + Number(b.amount || 0), 0);
      const myLoss  = myTotal - myWinTotal;
      const slot    = TYPE_TO_SLOT[winnerType];
      const liveMult = multipliersByType[winnerType] ?? (slot?.multiplier ?? 1);
      const payout = serverWinAmount != null
        ? Number(serverWinAmount)
        : (serverWinAmountRef.current != null
            ? Number(serverWinAmountRef.current)
            : Math.round(myWinTotal * liveMult));
      if (myWinTotal > 0 && slot) {
        setResultMessage(`${slot.icon} WON +${payout.toLocaleString()} 💎`);
      } else if (myLoss > 0 && slot) {
        setResultMessage(`${slot.icon} LOSS -${myLoss.toLocaleString()} 💎`);
      } else if (slot) {
        setResultMessage(`${slot.icon} ROUND OVER`);
      }
    };

    // Spin from current activeSlot to the winning slot, 4 full rotations
    // first, decelerating in the last 20 ticks.
    const target = winnerSlotId;
    // Effect-scoped cancellation flag. Cleanup flips it true, every
    // pending step() bails before touching state. This prevents the
    // "Can't perform a React state update on an unmounted component"
    // warning when the user navigates away mid-spin or the parent
    // unmounts because the live ended.
    let cancelled = false;

    if (!settleAnimRanRef.current) {
      settleAnimRanRef.current = true;
      spinStartSlotRef.current = activeSlot;
      const start  = spinStartSlotRef.current;
      const extra  = (target - start + 8) % 8;
      const totalJumps = (4 * 8) + extra;

      let i = 0;
      let speed = 40;
      const step = () => {
        if (cancelled) return;
        setActiveSlot((p) => (p + 1) % 8);
        i++;
        if (i < totalJumps) {
          if (i > totalJumps - 10) speed += 30;
          else if (i > totalJumps - 20) speed += 10;
          spinTimer.current = setTimeout(step, speed);
        } else {
          if (cancelled) return;
          // Spin landed on the winning slot — only NOW reveal the green
          // winner styling (Bug 2). Until this point isWinner is gated
          // FALSE so the cell looked like every other slot.
          setActiveSlot(target);
          setRevealed(true);
          // Append this round's winner to the local history dots. The
          // dedupe guard stops a double-call (re-render race) from
          // stacking the same round twice — checks the head entry's
          // timestamp by proxy of identity-of-reference.
          const winSlot = TYPE_TO_SLOT[winnerType];
          if (winSlot) {
            setHistory((prev) => {
              const head = prev[0];
              if (head && head.type === winnerType && head.ts === '_local') return prev;
              return [{ type: winnerType, icon: winSlot.icon, ts: '_local' }, ...prev].slice(0, 20);
            });
          }
          // Settle the on-screen banner. Use the LIVE multiplier from
          // game_settings (Bug 1) rather than the stale hard-coded SLOTS
          // value, so the message matches what the server actually paid.
          computeBanner();
        }
      };
      step();
    } else {
      // Spin already played for this round — just refresh the banner
      // text with whatever the latest serverWinAmount tells us.
      computeBanner();
    }
    // Auto-open the next round. Lives OUTSIDE the settleAnimRanRef
    // guard and uses its own timer ref so the settle effect's
    // cleanup (which kills the spin animation chain) does NOT also
    // kill the next-round scheduler. Without this separation, a
    // late serverWinAmount arriving after the spin finishes
    // re-runs this effect, the cleanup clears spinTimer (which
    // previously held the openRound setTimeout), and the next
    // round never opens — the table freezes on 'settled'.
    if (!nextRoundTimerRef.current) {
      const scheduledForRound = roundId;
      nextRoundTimerRef.current = setTimeout(() => {
        nextRoundTimerRef.current = null;
        // Defensive: only open the next round if we're still settled on
        // the same round we scheduled for. Stops a stale timer (from a
        // round whose openRound already happened via another path) from
        // double-firing and racing the new round's state (Issue 4).
        if (statusRef.current === 'settled' && roundIdRef.current === scheduledForRound) {
          openRound();
        }
      }, 4000);
    }
    return () => {
      cancelled = true;
      if (spinTimer.current) { clearTimeout(spinTimer.current); spinTimer.current = null; }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, winnerSlotId, serverWinAmount]);

  // Spinner during resolving phase (before winnerSlotId arrives) — just
  // keep the highlight cycling so the wheel doesn't freeze.
  useEffect(() => {
    if (status !== 'resolving') return undefined;
    const t = setInterval(() => setActiveSlot((p) => (p + 1) % 8), 80);
    return () => clearInterval(t);
  }, [status]);

  // Unmount safety — clear the next-round auto-open timer so closing
  // the game mid-settle doesn't fire openRound after we're gone.
  useEffect(() => () => {
    if (nextRoundTimerRef.current) {
      clearTimeout(nextRoundTimerRef.current);
      nextRoundTimerRef.current = null;
    }
    if (spinTimer.current) {
      clearTimeout(spinTimer.current);
      spinTimer.current = null;
    }
  }, []);

  // ── 6. Derived view models ──────────────────────────────────────────
  const pots = useMemo(() => {
    const acc = {};
    SLOTS.forEach(s => { acc[s.type] = 0; });
    betRows.forEach((b) => { acc[b.position] = (acc[b.position] || 0) + Number(b.amount || 0); });
    return acc;
  }, [betRows]);

  const myBets = useMemo(() => {
    const acc = {};
    SLOTS.forEach(s => { acc[s.type] = 0; });
    betRows.filter(b => b.user_id === user?.id).forEach((b) => {
      acc[b.position] = (acc[b.position] || 0) + Number(b.amount || 0);
    });
    return acc;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [betRows, user?.id]);

  // ── 7. Place a bet (server-validated, optimistic UI) ──────────────
  // The previous version held placingRef true until the RPC returned,
  // so a user tapping fast saw only their first tap register and the
  // rest silently dropped — felt broken on a slow network. We now
  // commit the optimistic state synchronously and fire-and-forget the
  // RPC. Each tap gets its own tempId so a per-bet rollback can still
  // find and remove the failing chip without affecting other in-flight
  // bets. Server-side `place_game_bet` is idempotent w.r.t. duplicates
  // (each bet is a separate row in game_round_bets keyed by id), so
  // concurrent in-flight RPCs are safe.
  const placeBet = (type) => {
    if (status !== 'betting' || !roundId) return;
    if (myDiamonds < selectedBet) {
      Alert.alert('Insufficient Diamonds', `You need at least ${selectedBet.toLocaleString()} 💎.`);
      return;
    }

    const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const optimisticRow = {
      id:        tempId,
      round_id:  roundId,
      user_id:   user?.id,
      position:  type,
      amount:    selectedBet,
      win_amount: 0,
      created_at: new Date().toISOString(),
      _optimistic: true,
    };
    setBetRows((cur) => [...cur, optimisticRow]);
    setMyDiamonds((prev) => Math.max(0, prev - selectedBet));

    // Background RPC — UI doesn't await this. On failure the rollback
    // targets the specific tempId so other concurrent bets that
    // succeeded stay put.
    (async () => {
      try {
        const { data, error } = await supabase.rpc('place_game_bet', {
          p_round_id: roundId,
          p_position: type,
          p_amount:   selectedBet,
        });
        if (error || !data?.success) {
          setBetRows((cur) => cur.filter((r) => r.id !== tempId));
          setMyDiamonds((prev) => prev + selectedBet);
          Alert.alert('Bet failed', data?.message || error?.message || 'Could not place bet.');
        }
      } catch (e) {
        setBetRows((cur) => cur.filter((r) => r.id !== tempId));
        setMyDiamonds((prev) => prev + selectedBet);
        Alert.alert('Bet failed', e?.message || 'Network error.');
      }
    })();
  };

  const bannerText =
    resultMessage ? resultMessage :
    status === 'betting'   ? `Betting closes in ${timeLeft}s` :
    status === 'resolving' ? 'Spinning…' :
    status === 'settled'   ? 'Result' : 'Connecting…';

  const bannerColor = resultMessage
    ? (resultMessage.includes('WON')
        ? '#4ADE80'
        : resultMessage.includes('LOSS') ? '#EF4444' : '#FFF')
    : '#38BDF8';

  const centerIcon = status === 'settled' && winnerType
    ? (TYPE_TO_SLOT[winnerType]?.icon || '🎰')
    : '🎰';

  return (
    <>
      <View style={styles.container}>
        <View style={styles.header}>
          <View style={styles.headerLeft}>
            <TouchableOpacity onPress={onBack} style={styles.headerIconBtn}>
              <Ionicons name="chevron-back" size={20} color="#FFF" />
            </TouchableOpacity>
            <View style={{ marginLeft: 10 }}>
              <Text style={styles.gameTitle}>Fruit Roulette</Text>
              <View style={styles.balanceRow}>
                <Text style={styles.balanceText}>💎 {myDiamonds.toLocaleString()}</Text>
              </View>
            </View>
          </View>

          <View style={styles.headerRight}>
            <TouchableOpacity onPress={() => setShowHistory(true)} style={styles.headerIconBtn}>
              <Ionicons name="time-outline" size={22} color="#FBBF24" />
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setShowHelp(true)} style={[styles.headerIconBtn, { marginLeft: 8 }]}>
              <Ionicons name="help-circle-outline" size={22} color="rgba(255,255,255,0.7)" />
            </TouchableOpacity>
            <TouchableOpacity onPress={onClose} style={[styles.headerIconBtn, { marginLeft: 8 }]}>
              <Ionicons name="close" size={22} color="rgba(255,255,255,0.5)" />
            </TouchableOpacity>
          </View>
        </View>

        <View style={styles.bannerArea}>
          <Text style={[styles.bannerText, { color: bannerColor }]} numberOfLines={1}>
            {bannerText}
          </Text>
        </View>

        {/* 3×3 grid — 8 slots ring the centre cell (which holds the
            spinning fruit emoji). pos[row, col] on each slot picks the
            cell. activeSlot drives the highlight cycle, revealed gates
            the winner green border. */}
        <View style={styles.gridContainer}>
          {[0, 1, 2].map((row) => (
            <View key={`r-${row}`} style={styles.row}>
              {[0, 1, 2].map((col) => {
                if (row === 1 && col === 1) {
                  return (
                    <View key="c" style={[styles.cell, styles.centerCell]}>
                      <Text style={styles.cellIcon}>{centerIcon}</Text>
                    </View>
                  );
                }
                const slot = SLOTS.find((s) => s.pos[0] === row && s.pos[1] === col);
                if (!slot) return <View key={`e-${row}-${col}`} style={styles.cell} />;
                const isActive = activeSlot === slot.id;
                const isWinner = status === 'settled' && revealed && winnerSlotId === slot.id;
                // Bug 1 (2026-06-15): show the LIVE multiplier from
                // game_settings, falling back to the slot constant if
                // the row hasn't been fetched yet (cold mount).
                const mult = multipliersByType[slot.type] ?? slot.multiplier;
                return (
                  <TouchableOpacity
                    key={slot.type}
                    onPress={() => placeBet(slot.type)}
                    disabled={status !== 'betting'}
                    activeOpacity={0.7}
                    style={[
                      styles.cell,
                      isActive && styles.cellActive,
                      isWinner && styles.winnerCell,
                    ]}
                  >
                    <Text style={styles.cellIcon}>{slot.icon}</Text>
                    <Text style={styles.cellMultiplier}>{mult}x</Text>
                    {pots[slot.type] > 0 && (
                      <Text style={styles.cellPot}>{formatCompactNumber(pots[slot.type])}</Text>
                    )}
                    {myBets[slot.type] > 0 && (
                      <View style={styles.gridBetBadge}>
                        <Text style={styles.gridBetText}>{formatCompactNumber(myBets[slot.type])}</Text>
                      </View>
                    )}
                  </TouchableOpacity>
                );
              })}
            </View>
          ))}
        </View>

        <View style={styles.chipsSection}>
          <View style={styles.chipTrack}>
            {BET_AMOUNTS.map((amt) => {
              const tooRich = amt > (myDiamonds || 0);
              return (
                <TouchableOpacity
                  key={amt}
                  style={[
                    styles.miniChip,
                    selectedBet === amt && styles.miniChipActive,
                    tooRich && { opacity: 0.35 },
                  ]}
                  disabled={tooRich}
                  onPress={() => setSelectedBet(amt)}
                  activeOpacity={0.7}
                >
                  <Text style={styles.miniChipText}>{formatCompactNumber(amt)}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>
      </View>

      {showHistory && (
        <Modal transparent visible={showHistory} animationType="fade" onRequestClose={() => setShowHistory(false)}>
          <TouchableOpacity style={styles.histOverlay} activeOpacity={1} onPress={() => setShowHistory(false)}>
            <LinearGradient colors={['#251B45', BRAND.splashBg]} style={styles.histCard}>
              <Text style={styles.histTitle}>Winning History</Text>
              <View style={styles.histGrid}>
                {history.length === 0 ? (
                  <Text style={{ color: 'rgba(255,255,255,0.5)' }}>No rounds yet.</Text>
                ) : (
                  history.map((h, i) => (
                    <View key={`${h.ts}-${i}`} style={styles.histCircle}>
                      <Text style={styles.histIcon}>{h.icon}</Text>
                    </View>
                  ))
                )}
              </View>
              <TouchableOpacity style={styles.histCloseBtn} onPress={() => setShowHistory(false)}>
                <Text style={styles.histCloseText}>Close</Text>
              </TouchableOpacity>
            </LinearGradient>
          </TouchableOpacity>
        </Modal>
      )}

      {showHelp && (
        <Modal transparent visible={showHelp} animationType="fade">
          <View style={styles.helpModalWrapper}>
            <TouchableOpacity style={styles.helpOverlayClose} activeOpacity={1} onPress={() => setShowHelp(false)} />
            <LinearGradient colors={['#251B45', BRAND.splashBg]} style={styles.helpCard}>
              <View style={styles.helpHeader}>
                <Ionicons name="game-controller" size={24} color="#FBBF24" />
                <Text style={styles.helpTitle}>Game Rules</Text>
                <TouchableOpacity onPress={() => setShowHelp(false)}>
                  <Ionicons name="close" size={24} color="rgba(255,255,255,0.5)" />
                </TouchableOpacity>
              </View>
              <ScrollView showsVerticalScrollIndicator={false}>
                <Text style={styles.helpContent}>
                  🎯 <Text style={{ fontWeight: 'bold', color: '#FFF' }}>Place Bets:</Text> Pick a chip and tap on a fruit you think will win.{'\n\n'}
                  ⏱ <Text style={{ fontWeight: 'bold', color: '#FFF' }}>Shared Round:</Text> Everyone in this room bets in the SAME 30-second round. The pot under each fruit is the live sum of all room bets.{'\n\n'}
                  🎰 <Text style={{ fontWeight: 'bold', color: '#FFF' }}>Spin:</Text> When time hits zero the wheel spins. Server picks one winning fruit for the whole room.{'\n\n'}
                  💎 <Text style={{ fontWeight: 'bold', color: '#FFF' }}>Payouts:</Text>
                  {'\n'}   🍎 Apple — {multipliersByType.apple ?? 5}x
                  {'\n'}   🍌 Banana — {multipliersByType.banana ?? 5}x
                  {'\n'}   🍊 Orange — {multipliersByType.orange ?? 5}x
                  {'\n'}   🍉 Watermelon — {multipliersByType.watermelon ?? 5}x
                  {'\n'}   🍇 Grapes — {multipliersByType.grapes ?? 10}x
                  {'\n'}   🍍 Pineapple — {multipliersByType.pineapple ?? 15}x
                  {'\n'}   🥭 Mango — {multipliersByType.mango ?? 25}x
                  {'\n'}   👑 Crown — {multipliersByType.crown ?? 45}x{'\n\n'}
                  ⚖ <Text style={{ fontWeight: 'bold', color: '#FFF' }}>Fair Play:</Text> Single server random per round — same result for every player.
                </Text>
              </ScrollView>
              <TouchableOpacity style={styles.gotItBtn} onPress={() => setShowHelp(false)}>
                <Text style={styles.gotItText}>Got It!</Text>
              </TouchableOpacity>
            </LinearGradient>
          </View>
        </Modal>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: 'transparent',
    paddingHorizontal: 16,
    alignItems: 'center',
    paddingTop: 4,
    paddingBottom: 10,
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    width: '100%',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
    paddingHorizontal: 4,
  },
  headerLeft:  { flexDirection: 'row', alignItems: 'center' },
  headerRight: { flexDirection: 'row', alignItems: 'center' },
  headerIconBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'center', alignItems: 'center' },
  gameTitle: { color: '#FFF', fontSize: 13, fontWeight: 'bold' },
  balanceRow: { flexDirection: 'row', alignItems: 'center', marginTop: 1 },
  balanceText: { color: '#FBBF24', fontSize: 10, fontWeight: '700' },

  // Compact banner above the grid — status / countdown / result text.
  bannerArea: {
    width: '100%',
    alignItems: 'center',
    paddingVertical: 6,
    marginBottom: 6,
  },
  bannerText: {
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 0.3,
  },

  // 3x3 grid — fixed-size square cells, centre cell holds the spinner.
  gridContainer: {
    alignSelf: 'center',
    marginVertical: 4,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'center',
  },
  cell: {
    width: 80,
    height: 80,
    margin: 4,
    borderRadius: 12,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.08)',
    position: 'relative',
  },
  centerCell: {
    backgroundColor: 'rgba(251,191,36,0.12)',
    borderColor: 'rgba(251,191,36,0.45)',
  },
  cellActive: {
    borderColor: '#FBBF24',
    backgroundColor: 'rgba(251,191,36,0.22)',
    shadowColor: '#FBBF24',
    shadowOpacity: 0.9,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 0 },
    elevation: 6,
  },
  winnerCell: {
    borderColor: '#4ADE80',
    backgroundColor: 'rgba(74,222,128,0.18)',
  },
  cellIcon: { fontSize: 30 },
  cellMultiplier: {
    color: '#FFF',
    fontSize: 10,
    fontWeight: '800',
    marginTop: 2,
  },
  cellPot: {
    color: 'rgba(255,255,255,0.85)',
    fontSize: 9,
    fontWeight: '700',
    marginTop: 1,
  },
  gridBetBadge: {
    position: 'absolute',
    top: -4,
    left: -4,
    backgroundColor: BRAND.primary,
    borderRadius: 10,
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderWidth: 1.5,
    borderColor: '#FFF',
  },
  gridBetText: { color: '#FFF', fontSize: 9, fontWeight: '800' },

  // Chip tray — 4 text-only pills.
  chipsSection: { marginTop: 10 },
  chipTrack: {
    flexDirection: 'row',
    backgroundColor: 'rgba(0,0,0,0.4)',
    padding: 4,
    borderRadius: 24,
    gap: 6,
  },
  miniChip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 2,
    borderColor: 'transparent',
    minWidth: 56,
    alignItems: 'center',
  },
  miniChipActive: {
    borderColor: '#FBBF24',
    backgroundColor: 'rgba(251,191,36,0.20)',
  },
  miniChipText: { color: '#FFF', fontSize: 11, fontWeight: '800' },

  helpModalWrapper: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  helpOverlayClose: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.75)' },
  helpCard: { width: '85%', borderRadius: 25, padding: 20, borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)' },
  helpHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 15, gap: 10 },
  helpTitle: { color: '#FFF', fontSize: 18, fontWeight: 'bold', flex: 1 },
  helpContent: { color: 'rgba(255,255,255,0.8)', fontSize: 13, lineHeight: 20 },
  gotItBtn: { marginTop: 18, paddingVertical: 12, backgroundColor: BRAND.primary, borderRadius: 20, alignItems: 'center' },
  gotItText: { color: '#FFF', fontWeight: 'bold' },

  // History modal — emoji-dot trail of recent winning fruits.
  histOverlay: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.75)' },
  histCard: { width: '85%', borderRadius: 25, padding: 22, borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)', alignItems: 'center' },
  histTitle: { color: '#FFF', fontSize: 18, fontWeight: 'bold', marginBottom: 16 },
  histGrid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 10, minHeight: 40 },
  histCircle: { width: 36, height: 36, borderRadius: 18, backgroundColor: 'rgba(255,255,255,0.08)', justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)' },
  histIcon: { fontSize: 20 },
  histCloseBtn: { marginTop: 18, paddingVertical: 11, paddingHorizontal: 32, backgroundColor: BRAND.primary, borderRadius: 20 },
  histCloseText: { color: '#FFF', fontWeight: 'bold', fontSize: 14 },
});
