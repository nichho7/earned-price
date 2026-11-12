// [CTO] T-033 · root layout. Fonts self-hosted by next/font (no request to Google from the browser),
// latin only. Serif 400 (the LCP hero text): swap, its metric-adjusted fallback measured 0 shift.
// Serif italic, Plex Sans, Plex Mono: their swap measured CLS 0.05 (mono, no fallback metrics) and 0.03
// (sans) on a cold load, which breaks the CLS 0 gate (B5, S-029 AC 3). So they use display "optional"
// (never swap after first paint) and are preloaded so they usually make the ~100 ms window. Change
// logged in ADR-001 B5 (2026-11-12).
// No head script yet: the `.motion` class arrives with M1 (S-028), so this stage ships no motion code.
import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans, Instrument_Serif } from "next/font/google";
import "./tokens.css";
import "./base.css";

const serif = Instrument_Serif({ weight: "400", style: "normal", subsets: ["latin"], display: "swap", variable: "--font-serif" });
const serifItalic = Instrument_Serif({ weight: "400", style: "italic", subsets: ["latin"], display: "optional", variable: "--font-serif-italic" });
const sans = IBM_Plex_Sans({ weight: ["400", "500"], subsets: ["latin"], display: "optional", variable: "--font-sans" });
const mono = IBM_Plex_Mono({ weight: ["400", "500"], subsets: ["latin"], display: "optional", variable: "--font-mono" });

export const metadata: Metadata = {
  title: "Earned Price: the record sets the price",
  description:
    "A seller agent is paid from testnet escrow only when a graded review passes, and every pass or fail moves its next quote. Testnet only, no real funds.",
  robots: { index: true, follow: true },
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${serif.variable} ${serifItalic.variable} ${sans.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
