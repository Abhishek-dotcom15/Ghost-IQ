import { lookup } from 'node:dns/promises';
import net from 'node:net';

/**
 * Hosted mode: users choose the URLs GhostIQ browses (run targets) and calls (webhooks).
 * Without a guard, a run against http://169.254.169.254/ or http://localhost:5432 turns
 * GhostIQ into a proxy into its own network. Private, loopback, link-local, CGNAT,
 * multicast and reserved ranges are refused unless the host is explicitly allowed.
 */

const BLOCKED_V4: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

function v4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

function inV4Range(ip: string, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (v4ToInt(ip) & mask) === (v4ToInt(base) & mask);
}

export function isPrivateAddress(address: string): boolean {
  if (net.isIPv4(address)) return BLOCKED_V4.some(([base, bits]) => inV4Range(address, base, bits));
  if (net.isIPv6(address)) {
    const a = address.toLowerCase();
    const mapped = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]!);
    return (
      a === '::' ||
      a === '::1' ||
      a.startsWith('fc') ||
      a.startsWith('fd') ||
      /^fe[89ab]/.test(a) ||
      a.startsWith('ff') ||
      a.startsWith('64:ff9b:') ||
      a.startsWith('2001:db8')
    );
  }
  return true; // not an IP at all: refuse
}

export class BlockedTargetError extends Error {}

export interface SsrfOptions {
  /** Hostnames (exact, case-insensitive) allowed even when private, e.g. "mock-app". */
  allowedHosts: string[];
  resolve?: (host: string) => Promise<string[]>;
}

const defaultResolve = async (host: string) =>
  (await lookup(host, { all: true, verbatim: true })).map((r) => r.address);

/** Throws BlockedTargetError when the URL is not http(s) or reaches a private address. */
export async function assertPublicUrl(raw: string, options: SsrfOptions): Promise<void> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BlockedTargetError('Not a valid URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BlockedTargetError(`Only http and https URLs are allowed (got ${url.protocol}).`);
  }
  if (url.username || url.password)
    throw new BlockedTargetError('URLs with credentials are not allowed.');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (options.allowedHosts.map((h) => h.toLowerCase()).includes(host)) return;
  const addresses = net.isIP(host)
    ? [host]
    : await (options.resolve ?? defaultResolve)(host).catch(() => []);
  if (addresses.length === 0) throw new BlockedTargetError(`${host} does not resolve.`);
  const blocked = addresses.find(isPrivateAddress);
  if (blocked) {
    throw new BlockedTargetError(
      `${host} resolves to a private or internal address (${blocked}); hosted GhostIQ only tests public sites. An operator can allow it with GHOSTIQ_ALLOWED_TARGETS.`,
    );
  }
}

export function parseAllowedHosts(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);
}
