// [CTO] T-033 site config (ADR-001 Addendum B). Keep it small: every option here is a decision.
import type { NextConfig } from "next";

// T-039 security L-2: a strict CSP on /verify only, the page that renders an untrusted receipt.json. Static App
// Router pages can't carry nonces, so scripts need 'unsafe-inline' (Next guide "Without Nonces",
// node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md). What it adds is defence in depth:
// connect-src 'self' makes "no server call" browser-enforced against third-party beacons, img-src stops a
// future <img src={claim}> leak, and frame-ancestors stops framing. Dev needs 'unsafe-eval' (same guide).
// `/` is left alone on purpose: T-034 adds wallet / RPC calls there, which a copied policy would block.
const dev = process.env.NODE_ENV === "development";
const VERIFY_CSP = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

const config: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  async headers() {
    return [
      {
        source: "/verify",
        headers: [
          { key: "Content-Security-Policy", value: VERIFY_CSP },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      },
    ];
  },
};

export default config;
