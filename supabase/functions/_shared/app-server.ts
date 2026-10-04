type SettingsClient = {
  from: (table: string) => {
    select: (columns: string) => {
      eq: (column: string, value: string) => {
        maybeSingle: () => Promise<{ data: { value?: unknown } | null; error: { message?: string } | null }>;
      };
    };
  };
};

export async function appServerConnected(client: SettingsClient): Promise<boolean> {
  const { data, error } = await client
    .from('system_settings')
    .select('value')
    .eq('key', 'app_server_connected')
    .maybeSingle();
  if (error) throw new Error(error.message || 'Could not read app server state');
  return data?.value !== false;
}

export function serverDisconnectedResponse(headers: Record<string, string>) {
  return new Response(JSON.stringify({
    success: false,
    allowed: false,
    code: 'APP_SERVER_DISCONNECTED',
    error: 'The application server is temporarily disconnected.',
  }), {
    status: 503,
    headers: { ...headers, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
