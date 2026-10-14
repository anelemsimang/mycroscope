/** The caller's public address, taken from proxy headers. Private addresses are ignored. */

const V4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const V6 = /^[0-9a-f:]+$/i;

function parts4(ip: string): number[] | null {
  if (!V4.test(ip)) return null;
  const parts = ip.split('.').map((p) => Number(p));
  return parts.every((n) => n >= 0 && n <= 255) ? parts : null;
}

/** True for an address that can be a household or office public address. */
export function isPublicAddress(ip: string): boolean {
  const v4 = parts4(ip);
  if (v4) {
    const [a, b] = v4;
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a >= 224) return false;
    return true;
  }
  if (!ip.includes(':') || !V6.test(ip) || ip.length > 45) return false;
  const head = ip.toLowerCase();
  if (head === '::1' || head.startsWith('fc') || head.startsWith('fd') || head.startsWith('fe80')) return false;
  return true;
}

export function clientAddress(headers: { get(name: string): string | null }): string | null {
  const forwarded = headers.get('x-forwarded-for') ?? '';
  const candidates = [...forwarded.split(','), headers.get('cf-connecting-ip') ?? '', headers.get('x-real-ip') ?? ''];
  for (const raw of candidates) {
    const value = raw.trim().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
    if (isPublicAddress(value)) return value;
  }
  return null;
}
