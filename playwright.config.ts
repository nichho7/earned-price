// [CTO] T-033 · Playwright: Chromium + WebKit from day one (ADR-001 B4 R8). Runs against the
// production build (`next start`), never the dev server, so it tests what ships.
import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.SITE_PORT ?? 3100);

export default defineConfig({
  testDir: "site/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: "retain-on-failure" },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
  webServer: {
    command: `npx next start -p ${PORT} -H 127.0.0.1`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: false, // never test a stale server left on the port (code review L-7)
    timeout: 60_000,
  },
});
