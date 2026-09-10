import type { RedisClientType } from 'redis';
export class Sequencer {
  private local = Date.now() * 1000;
  constructor(private readonly redis?: RedisClientType) {}
  async next(): Promise<number> { return this.redis ? Number(await this.redis.incr('crash:global:socket-sequence')) : ++this.local; }
}
