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
};

export default nextConfig;
