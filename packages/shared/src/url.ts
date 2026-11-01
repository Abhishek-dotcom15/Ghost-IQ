/**
 * Groups endpoint telemetry by route: drops query string and hash, keeps origin + path.
 * `/api/users?id=42` and `/api/users?id=7` become the same endpoint.
 * Falls back to stripping the query for relative or unparsable URLs.
 */
export function normalizeEndpointUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    return `${url.origin}${url.pathname}`;
  } catch {
    return rawUrl.split(/[?#]/)[0] ?? rawUrl;
  }
}
