import type { Namespace } from 'socket.io';
import { config, instanceId } from './config.js';
import { rpc, serviceDb } from './database.js';
import { envelope } from './envelope.js';
import type { Sequencer } from './sequencer.js';
import type { Logger } from 'pino';
import { engineLeader } from './metrics.js';

export class CrashEngine {
  private epoch = 0; private timer?: NodeJS.Timeout; private leaseAt = 0; private running = false;
  constructor(private readonly io: Namespace, private readonly seq: Sequencer, private readonly log: Logger) {}
  start() { this.timer = setInterval(() => void this.step(), 100); }
  stop() { if (this.timer) clearInterval(this.timer); }
  private async step() {
    if (this.running) return; this.running = true;
    try {
      if (Date.now() - this.leaseAt > 1500) {
        const lease = await rpc(serviceDb, 'crash_acquire_lease', { p_game_id: config.CRASH_GAME_ID, p_table_id: config.CRASH_TABLE_ID, p_instance_id: instanceId, p_ttl_ms: 5000 });
        this.leaseAt = Date.now(); this.epoch = lease.leader ? Number(lease.epoch) : 0; engineLeader.set(this.epoch?1:0);
      }
      if (!this.epoch) return;
      const round=await rpc(serviceDb, 'crash_engine_advance', { p_game_id: config.CRASH_GAME_ID, p_table_id: config.CRASH_TABLE_ID, p_instance_id: instanceId, p_epoch: this.epoch });
      if (round.status === 'RUNNING' && round.flight_started_at) {
        const elapsedMs=Math.max(0,Date.now()-new Date(String(round.flight_started_at)).getTime()); const multiplierBp=Math.floor(Math.exp(Number(round.growth_rate||0.08)*elapsedMs/1000)*100);
        this.io.to(`crash:${config.CRASH_TABLE_ID}`).emit('round:tick',await envelope(this.seq,config.CRASH_TABLE_ID,String(round.round_id),{elapsedMs,multiplierBp,stateVersion:round.state_version}));
      }
    } catch (error) { this.log.error({ error }, 'engine step failed'); }
    finally { this.running = false; }
  }
}
