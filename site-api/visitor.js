// T-028: per-visitor identity for the 3-a-day cap.
//
// Identity = HMAC-SHA256(secret, client IP), IPv6 cut to its /64 (one home or phone network), IPv4
// as is. Only the hash is kept, never the IP. On Vercel the IP headers are set by the platform:
// "we currently overwrite the X-Forwarded-For header and do not forward external IPs"
// (https://vercel.com/docs/headers/request-headers, read 2026-11-12), so a client can't pick its
// own. x-real-ip is read first (security I-1: Vercel sets it; whether a client-sent
// x-vercel-forwarded-for is always stripped could not be confirmed offline). Off Vercel (local dev) these headers are client-controlled; don't rely on the cap there.
//
// What it does NOT stop (say so, don't overclaim): a new IP resets it (VPN, mobile network, Tor,
// another /64); people behind one NAT (an office, a venue) share 3. Clearing cookies or making a
// new testnet buyer account does not reset it, and the handler also counts 3 per buyer account.
import { createHmac } from "node:crypto";
import { isIP } from "node:net";

const IP_HEADERS = ["x-real-ip", "x-vercel-forwarded-for", "x-forwarded-for"];

/** Header lookup on a Web Headers object or a plain object. */
export const header = (headers, name) => (typeof headers?.get === "function" ? headers.get(name) : (headers?.[name] ?? null));

/** The client IP from the first platform header that holds a valid one (first hop), else null. */
export function clientIp(headers) {
  for (const name of IP_HEADERS) {
    const raw = header(headers, name);
    if (typeof raw !== "string" || raw === "") continue;
    const first = raw.split(",")[0].trim();
    return isIP(first) ? first : null;
  }
  return null;
}

/** IPv4 as is; IPv4-mapped IPv6 as IPv4; other IPv6 as its /64 prefix "a:b:c:d::/64"; else null. */
export function normaliseIp(ip) {
  const kind = isIP(String(ip));
  if (kind === 4) return ip;
  if (kind !== 6) return null;
  const lower = ip.toLowerCase();
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return mapped[1];
  const [head, tail = null] = lower.split("::");
  const h = head ? head.split(":") : [];
  const t = tail === null ? [] : tail ? tail.split(":") : [];
  const groups = tail === null ? h : [...h, ...Array(8 - h.length - t.length).fill("0"), ...t];
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

/** 32 hex chars: the keyed hash of the normalised client IP ("unknown" when there is none). */
export function visitorId(headers, secret) {
  const ip = clientIp(headers);
  const norm = (ip && normaliseIp(ip)) || "unknown";
  return createHmac("sha256", String(secret)).update(norm).digest("hex").slice(0, 32);
}
