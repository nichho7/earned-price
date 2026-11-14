// [CTO] T-103 · the Earned Price logo (A-033) on the site, against `next start`.
// Header: the mark + live-text wordmark is one link home named "Earned Price", on /, /live and /verify, at phone and
// desktop width; the mark is inline (no image request) and painted in the reverse colourway on the violet header;
// no CSP report on /live or /verify. Files: the icons and the social card the HTML points at all load from this origin
// with the right content type, the card is 1200 x 630 with its alt text, and its URL is absolute (metadataBase).
import { expect, test, type Page } from "@playwright/test";

const ROUTES = ["/", "/live", "/verify"] as const;
// tokens.css: --cream #FBF9F3 (stamp), --violet #5B34DB (ink) = mark-reverse on a violet ground
const CREAM = "rgb(251, 249, 243)";
const VIOLET = "rgb(91, 52, 219)";
const ALT = "Earned Price. Pay AI agents only when their work passes. Their track record sets the price.";

const brand = (page: Page) => page.locator("header").getByRole("link", { name: "Earned Price", exact: true });

for (const route of ROUTES) {
  for (const width of [390, 1440]) {
    test(`${route} @${width}: header logo is a link home named "Earned Price"`, async ({ page }) => {
      const csp: string[] = [];
      page.on("console", (m) => { if (/Content Security Policy/i.test(m.text())) csp.push(m.text()); });
      const images: string[] = [];
      page.on("request", (r) => { if (r.resourceType() === "image") images.push(r.url()); });
      await page.setViewportSize({ width, height: 900 });
      await page.goto(route);

      const link = brand(page);
      await expect(link).toHaveCount(1);
      await expect(link).toBeVisible();
      expect(new URL((await link.getAttribute("href"))!, page.url()).pathname).toBe("/");
      const mark = link.locator("svg[data-brand-mark]");
      await expect(mark).toBeVisible();
      await expect(mark).toHaveAttribute("aria-hidden", "true");
      await expect(link.getByText("Earned Price", { exact: true })).toBeVisible();
      const box = (await mark.boundingBox())!;
      expect(Math.round(box.height)).toBe(30); // Designer README: 30 px in the header

      const paint = await mark.evaluate((svg) => {
        const [stamp, ink] = svg.querySelectorAll("path");
        return { stamp: getComputedStyle(stamp).fill, ink: getComputedStyle(ink).stroke };
      });
      expect(paint).toEqual({ stamp: CREAM, ink: VIOLET });
      expect(images.filter((u) => /mark|logo|lockup/i.test(u))).toEqual([]);
      expect(csp).toEqual([]);
    });
  }
}

test("/ header: the mark swaps to the light colourway on a cream ground and back on night", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  const hdr = page.locator("#hdr");
  const paint = () => brand(page).locator("svg[data-brand-mark]").evaluate((svg) => {
    const [stamp, ink] = svg.querySelectorAll("path");
    return { stamp: getComputedStyle(stamp).fill, ink: getComputedStyle(ink).stroke };
  });
  // scroll-padding-top would leave the night section above under the header: put #how's top at the viewport top
  await page.locator("#how").evaluate((el) => window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY, behavior: "instant" }));
  await expect(hdr).toHaveAttribute("data-ground", "cream");
  expect(await paint()).toEqual({ stamp: VIOLET, ink: "rgb(245, 213, 59)" }); // mark.svg: violet stamp, canary ink
  await page.locator("#trust").evaluate((el) => window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY, behavior: "instant" }));
  await expect(hdr).toHaveAttribute("data-ground", "night");
  expect(await paint()).toEqual({ stamp: CREAM, ink: VIOLET });
});

test("icons and the social card load from this origin with the right type", async ({ page, request }) => {
  await page.goto("/");
  const head = page.locator("head");
  const attr = (sel: string, name: string) => head.locator(sel).first().getAttribute(name);
  const files: [string | null, string][] = [
    [await attr('link[rel="icon"][href^="/favicon.ico"]', "href"), "image/x-icon"],
    [await attr('link[rel="icon"][href^="/icon"]', "href"), "image/png"],
    [await attr('link[rel="apple-touch-icon"]', "href"), "image/png"],
    [await attr('meta[property="og:image"]', "content"), "image/png"],
    [await attr('meta[name="twitter:image"]', "content"), "image/png"],
  ];
  for (const [href, type] of files) {
    expect(href, type).toBeTruthy();
    const url = new URL(href!, page.url());
    const res = await request.get(url.pathname + url.search);
    expect(res.status(), url.pathname).toBe(200);
    expect(res.headers()["content-type"], url.pathname).toContain(type);
  }
  // social card: absolute URL (metadataBase), 1200 x 630, alt text, large card on X
  const og = (await attr('meta[property="og:image"]', "content"))!;
  expect(og).toMatch(/^https?:\/\/[^/]+\/opengraph-image\.png/);
  expect(await attr('meta[property="og:image:width"]', "content")).toBe("1200");
  expect(await attr('meta[property="og:image:height"]', "content")).toBe("630");
  expect(await attr('meta[property="og:image:alt"]', "content")).toBe(ALT);
  expect(await attr('meta[name="twitter:image:alt"]', "content")).toBe(ALT);
  expect(await attr('meta[name="twitter:card"]', "content")).toBe("summary_large_image");
  expect(await attr('link[rel="apple-touch-icon"]', "sizes")).toBe("180x180");
});

test("/live and /verify carry the same icons and card", async ({ page }) => {
  for (const route of ["/live", "/verify"]) {
    await page.goto(route);
    await expect(page.locator('head link[rel="apple-touch-icon"]')).toHaveCount(1);
    await expect(page.locator('head meta[property="og:image"]')).toHaveAttribute("content", /\/opengraph-image\.png/);
  }
});
