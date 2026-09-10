import { supabase } from './supabase';
import { getDeviceIdentity } from '../device/deviceIdentity';
import { DeviceAccessTransportError, normalizeDeviceAccessResult } from './deviceAccessPolicy';

export async function verifyDeviceAccess() {
  try {
    const identity = await getDeviceIdentity();
    const { data, error } = await supabase.functions.invoke('device-access', { body: identity });
    if (error) throw error;
    return normalizeDeviceAccessResult(data);
  } catch (error) {
    if (error instanceof DeviceAccessTransportError) throw error;
    throw new DeviceAccessTransportError(error);
  }
}
