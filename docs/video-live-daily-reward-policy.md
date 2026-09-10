# Video Live Daily Reward Policy

## Enforced behavior

- Audio live earns no daily live reward and no task-center live-duration reward.
- A host earns the configured bean reward only after 3,600 uninterrupted, server-measured seconds in one video stream.
- The reward is paid at most once per `Asia/Dhaka` calendar day.
- A heartbeat gap longer than 45 seconds resets continuous progress to zero. The host can qualify again only after a new uninterrupted hour.
- Closing, backgrounding, disconnecting, ending, or restarting the live therefore cannot preserve partial continuous progress.
- Duplicate or concurrent heartbeats cannot double-pay and do not reset progress when their measured interval is zero.

## Authority and integrity

The mobile client only sends authenticated heartbeats. PostgreSQL locks the live-stream row, calculates elapsed time from server timestamps, validates ownership/status/type, and atomically claims the unique `(user_id, reward_date)` record before crediting beans. RLS prevents clients from writing reward records directly.

Legacy `host_live_*` and audio reward tasks are disabled. Their historical progress is retained for audit, but the claim RPC independently rejects them even if a catalogue row is accidentally re-enabled.

## Migration safety

Migration `20260825042000_strict_video_live_reward_policy.sql` is additive/idempotent for columns and tables and replaces only the two public RPC implementations that own rewards. It drops the obsolete live-task progress trigger. Existing rewards already paid for the current day remain honored; the migration does not claw back balances. The migration must be reviewed and deployed through the normal Supabase process—it is intentionally not deployed by this change.

