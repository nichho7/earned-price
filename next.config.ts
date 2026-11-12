// [CTO] T-033 site config (ADR-001 Addendum B). Keep it small: every option here is a decision.
import type { NextConfig } from "next";

const config: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
};

export default config;
