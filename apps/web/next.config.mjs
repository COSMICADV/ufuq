/**
 * @type {import('next').NextConfig}
 *
 * `transpilePackages` lets Next compile the workspace packages from source
 * output rather than expecting a bundler-ready build from each of them. It is
 * the supported monorepo arrangement and keeps @ufuq/i18n a plain TypeScript
 * package with no bundler concerns of its own.
 */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@ufuq/design-tokens', '@ufuq/i18n'],
  /**
   * Hosted staging serves the API under the web origin. Session and CSRF
   * cookies are host-only and `SameSite=Lax` (DOCUMENT 20 §6), and the CSRF
   * double-submit reads its cookie from `document.cookie`, so on a provider
   * whose generated hostnames are separate sites (`*.onrender.com` is on the
   * Public Suffix List) the browser must reach the API through this origin.
   * Opt-in: unset locally, where `localhost` already shares cookies.
   */
  async rewrites() {
    const target = process.env.API_PROXY_TARGET?.replace(/\/$/, '');
    return target ? [{ source: '/api/v1/:path*', destination: `${target}/api/v1/:path*` }] : [];
  },
};

export default nextConfig;
