import type { DevicePreset, NetworkProfile, PersonaSpec } from '@ghostiq/shared';

export interface ResolvedDevice {
  label: string;
  viewport: { width: number; height: number };
  isMobile: boolean;
  hasTouch: boolean;
  deviceScaleFactor: number;
  userAgent?: string;
}

const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const PIXEL_UA =
  'Mozilla/5.0 (Linux; Android 15; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36';

const PRESETS: Record<DevicePreset, ResolvedDevice> = {
  desktop: {
    label: 'Desktop 1440x900',
    viewport: { width: 1440, height: 900 },
    isMobile: false,
    hasTouch: false,
    deviceScaleFactor: 1,
  },
  laptop: {
    label: 'Laptop 1280x720',
    viewport: { width: 1280, height: 720 },
    isMobile: false,
    hasTouch: false,
    deviceScaleFactor: 1,
  },
  tablet: {
    label: 'Tablet 820x1180',
    viewport: { width: 820, height: 1180 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
  },
  'iphone-13': {
    label: 'iPhone 13',
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 3,
    userAgent: IPHONE_UA,
  },
  'pixel-7': {
    label: 'Pixel 7',
    viewport: { width: 412, height: 915 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2.625,
    userAgent: PIXEL_UA,
  },
};

export function resolveDevice(device: PersonaSpec['device']): ResolvedDevice {
  if (typeof device === 'string') return PRESETS[device];
  return {
    label: `Custom ${device.width}x${device.height}`,
    viewport: { width: device.width, height: device.height },
    isMobile: device.mobile,
    hasTouch: device.has_touch ?? device.mobile,
    deviceScaleFactor: device.device_scale_factor ?? 1,
    userAgent: device.user_agent,
  };
}

export interface NetworkConditions {
  /** Added round-trip latency, ms. */
  latency: number;
  /** Bytes per second. */
  downloadThroughput: number;
  uploadThroughput: number;
}

const kbps = (n: number) => Math.round((n * 1024) / 8);

/** Chrome DevTools' 3G presets (DevTools calls fast-3g simply "3G"). */
export const NETWORK_CONDITIONS: Record<Exclude<NetworkProfile, 'none'>, NetworkConditions> = {
  'fast-3g': { latency: 563, downloadThroughput: kbps(1600), uploadThroughput: kbps(750) },
  'slow-3g': { latency: 2000, downloadThroughput: kbps(400), uploadThroughput: kbps(400) },
};

export function resolveNetwork(profile: NetworkProfile): NetworkConditions | null {
  return profile === 'none' ? null : NETWORK_CONDITIONS[profile];
}
