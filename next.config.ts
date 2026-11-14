// [CTO] T-033 site config (ADR-001 Addendum B). Keep it small: every option here is a decision.
import type { NextConfig } from "next";

// T-039 security L-2: a strict CSP on /verify only, the page that renders an untrusted receipt.json. Static App
// Router pages can't carry nonces, so scripts need 'unsafe-inline' (Next guide "Without Nonces",
// node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md). What it adds is defence in depth:
// connect-src 'self' makes "no server call" browser-enforced against third-party beacons, img-src stops a
// future <img src={claim}> leak, and frame-ancestors stops framing. Dev needs 'unsafe-eval' (same guide).
// `/` is left alone on purpose: T-034 adds wallet / RPC calls there, which a copied policy would block.
const dev = process.env.NODE_ENV === "development";
const csp = (connect: string, form: string) => [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  `connect-src ${connect}`,
  "object-src 'none'",
  "base-uri 'none'",
  `form-action ${form}`,
  "frame-ancestors 'none'",
].join("; ");
export const VERIFY_CSP = csp("'self'", "'none'");

// T-092 (T-034 security L-3): /live holds the browser buyer's testnet key in localStorage, so the same CSP with
// connect-src opened to exactly the hosts /live calls: 'self' (POST /api/review, site/live/review.js REVIEW_URL),
// the faucet (site/live/account.js FAUCET_URL) and both testnet RPCs incl. the fallback (account.js RPC_URLS, also
// used by near-api-js JsonRpcProvider for send_tx). A drift test (site/headers.test.ts) fails if those constants
// change and this list does not. nearblocks.io is only ever a link (navigation), never fetched, so it is not here.
export const LIVE_CONNECT = ["https://helper.nearprotocol.com", "https://test.rpc.fastnear.com", "https://rpc.testnet.near.org"];
export const LIVE_CSP = csp(["'self'", ...LIVE_CONNECT].join(" "), "'self'");

const strict = (policy: string, referrer: string) => [
  { key: "Content-Security-Policy", value: policy },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: referrer },
];

const config: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  // T-100: the /api/review function reads the exam packs from disk (packs/packs.js); ship them in its bundle.
  outputFileTracingIncludes: { "/api/review": ["./packs/**"] },
  async headers() {
    return [
      { source: "/verify", headers: strict(VERIFY_CSP, "no-referrer") },
      // strict-origin-when-cross-origin (the auditor's L-3 value): the faucet and RPCs see our origin only, never a path.
      { source: "/live", headers: strict(LIVE_CSP, "strict-origin-when-cross-origin") },
    ];
  },
};

export default config;
