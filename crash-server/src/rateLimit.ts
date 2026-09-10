import type { RedisClientType } from 'redis';
export class RateLimiter{
  private local=new Map<string,{count:number,expires:number}>();
  private localPresence=new Map<string,Map<string,number>>();
  constructor(private redis?:RedisClientType,private now:()=>number=Date.now){}
  async allow(key:string,limit:number,windowSeconds:number){if(this.redis){const redisKey=`crash:rate:${key}`;const count=await this.redis.incr(redisKey);if(count===1)await this.redis.expire(redisKey,windowSeconds);return count<=limit}const now=Date.now(),row=this.local.get(key);if(!row||row.expires<=now){this.local.set(key,{count:1,expires:now+windowSeconds*1000});return true}row.count++;return row.count<=limit}
  async enterConnection(tableId:string,connectionId:string,max:number){const expires=this.now()+90_000;if(this.redis){const result=await this.redis.eval("redis.call('ZREMRANGEBYSCORE',KEYS[1],'-inf',ARGV[1]); local n=redis.call('ZCARD',KEYS[1]); if n>=tonumber(ARGV[3]) then return 0 end; redis.call('ZADD',KEYS[1],ARGV[2],ARGV[4]); redis.call('PEXPIRE',KEYS[1],180000); return 1",{keys:[`crash:presence:${tableId}`],arguments:[String(this.now()),String(expires),String(max),connectionId]});return Number(result)===1}const rows=this.localPresence.get(tableId)??new Map<string,number>();for(const [id,expiry] of rows)if(expiry<=this.now())rows.delete(id);if(rows.size>=max)return false;rows.set(connectionId,expires);this.localPresence.set(tableId,rows);return true}
  async refreshConnection(tableId:string,connectionId:string){const expires=this.now()+90_000;if(this.redis){await this.redis.zAdd(`crash:presence:${tableId}`,[{score:expires,value:connectionId}]);return}this.localPresence.get(tableId)?.set(connectionId,expires)}
  async leaveConnection(tableId:string,connectionId:string){if(this.redis){await this.redis.zRem(`crash:presence:${tableId}`,connectionId).catch(()=>0);return}this.localPresence.get(tableId)?.delete(connectionId)}
}
