/** Estados do device (seção 7.4 do doc). */
export const DEVICE_STATES = [
  'idle',
  'listening',
  'thinking',
  'speaking',
  'meeting',
  'alert',
  'error',
] as const;

export type DeviceState = (typeof DEVICE_STATES)[number];
