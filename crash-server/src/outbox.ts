import type { Namespace } from 'socket.io'; import type { Logger } from 'pino';
import { config, instanceId } from './config.js'; import { rpc, serviceDb } from './database.js'; import { envelope } from './envelope.js'; import type { Sequencer } from './sequencer.js';
import { outboxPublished } from './metrics.js';
export class OutboxPublisher {
  private timer?: NodeJS.Timeout; private busy=false;
  constructor(private io: Namespace,private seq:Sequencer,private log:Logger){}
  start(){this.timer=setInterval(()=>void this.poll(),50)} stop(){if(this.timer)clearInterval(this.timer)}
  private async poll(){if(this.busy)return;this.busy=true;try{const rows=await rpc<any[]>(serviceDb,'crash_claim_events',{p_instance_id:instanceId,p_limit:100});const ack:number[]=[];for(const row of rows||[]){const proposed=row.socket_sequence??await this.seq.next();const assigned=await rpc<number>(serviceDb,'crash_assign_event_socket_sequence',{p_event_id:row.event_id,p_socket_sequence:proposed});const msg=durableEventEnvelope(row,assigned);const target=row.audience_user_id?`user:${row.audience_user_id}`:`crash:${row.table_id}`;this.io.to(target).emit(row.event_type,msg);ack.push(Number(row.sequence));outboxPublished.inc();}if(ack.length)await rpc(serviceDb,'crash_ack_events',{p_instance_id:instanceId,p_sequences:ack});const bots=await rpc<any[]>(serviceDb,'crash_claim_due_bots',{p_instance_id:instanceId,p_limit:50});for(const bot of bots||[])this.io.to(`crash:${config.CRASH_TABLE_ID}`).emit('bet:public_activity',await envelope(this.seq,config.CRASH_TABLE_ID,bot.round_id,{id:bot.id,name:bot.robot_name,amount:bot.amount,cashoutMultiplierBp:bot.cashout_target_bp,simulated:true}));}catch(error){this.log.error({error},'outbox poll failed')}finally{this.busy=false}}
  async drain(){this.stop();for(let i=0;i<20&&this.busy;i++)await new Promise(r=>setTimeout(r,25));}
}

export function durableEventEnvelope(row:any,assignedSequence:number){return {protocolVersion:2,eventId:row.event_id,gameId:'crash',tableId:row.table_id,roundId:row.round_id,sequence:Number(assignedSequence),serverTime:new Date(row.created_at).toISOString(),payload:row.payload}}
