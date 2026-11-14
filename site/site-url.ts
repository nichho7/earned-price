// [CTO] T-103 · the site's own origin, for metadataBase (absolute og:image / twitter:image URLs). Never a hardcoded
// domain: Vercel's system env vars at build time (https://vercel.com/docs/environment-variables/system-environment-variables),
// in the same order Next uses when metadataBase is missing (node_modules/next/dist/lib/metadata/resolvers/resolve-url.js
// getSocialImageMetadataBaseFallback): a preview build uses its branch / deployment URL, any other Vercel build the
// project's production domain (then the deployment URL), and a local build localhost:PORT.
// Skills used: source-driven-development, karpathy-guidelines

type Env = Record<string, string | undefined>;

const hostUrl = (host: string | undefined): URL | null => {
  if (!host) return null;
  try {
    const u = new URL(`https://${host}`);
    return u.host === host.toLowerCase() ? u : null; // a bare host only: no path, no credentials, no scheme
  } catch {
    return null;
  }
};

export function siteOrigin(env: Env = process.env): URL {
  const preview = env.VERCEL_ENV === "preview";
  const candidates = preview
    ? [env.VERCEL_BRANCH_URL, env.VERCEL_URL, env.VERCEL_PROJECT_PRODUCTION_URL]
    : [env.VERCEL_PROJECT_PRODUCTION_URL, env.VERCEL_URL];
  for (const c of candidates) {
    const u = hostUrl(c);
    if (u) return u;
  }
  return new URL(`http://localhost:${env.PORT || 3000}`);
}
