import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
export const registry=new Registry(); collectDefaultMetrics({register:registry});
export const connections=new Gauge({name:'crash_socket_connections',help:'Current crash socket connections',registers:[registry]});
export const commands=new Counter({name:'crash_commands_total',help:'Crash commands by result',labelNames:['type','result'] as const,registers:[registry]});
export const commandLatency=new Histogram({name:'crash_command_seconds',help:'Crash command latency',labelNames:['type'] as const,registers:[registry]});
export const engineLeader=new Gauge({name:'crash_engine_leader',help:'1 when this instance owns the engine lease',registers:[registry]});
export const outboxPublished=new Counter({name:'crash_outbox_published_total',help:'Published durable crash events',registers:[registry]});
