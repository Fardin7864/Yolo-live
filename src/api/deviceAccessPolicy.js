export const DEVICE_ACCESS_NETWORK_MESSAGE = 'Internet connection failed';

export class DeviceAccessTransportError extends Error {
  constructor(cause) {
    super(DEVICE_ACCESS_NETWORK_MESSAGE);
    this.name = 'DeviceAccessTransportError';
    this.code = 'NETWORK_FAILED';
    this.cause = cause;
  }
}

export const normalizeDeviceAccessResult = (data) => {
  if (!data || typeof data.allowed !== 'boolean') {
    throw new DeviceAccessTransportError(new Error('Invalid device verification response'));
  }
  return data;
};

export const isDeviceAccessTransportError = (error) => (
  error instanceof DeviceAccessTransportError || error?.code === 'NETWORK_FAILED'
);
