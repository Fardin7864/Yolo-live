type RpcHandler = (name: string, args?: Record<string, unknown>) => Promise<{
  data: Record<string, unknown> | null;
  error: { message: string } | null;
}>;

let rpcHandler: RpcHandler = async () => ({ data: null, error: { message: 'Unexpected test RPC.' } });

export function setTestRpcHandler(handler: RpcHandler) {
  rpcHandler = handler;
}

const createChannel = () => {
  const channel = {
    on: () => channel,
    subscribe: () => channel,
    send: async () => ({ status: 'ok' }),
  };
  return channel;
};

export const supabase = {
  rpc: (name: string, args?: Record<string, unknown>) => rpcHandler(name, args),
  channel: () => createChannel(),
  removeChannel: async () => undefined,
};
