import type { MetadataRoute } from 'next';

/**
 * The web app manifest: what a phone uses when someone adds 1to1OS to the
 * home screen or installs it. Icons are the approved 1to1OS app icon; the
 * maskable ones keep the lettering inside the launcher's safe zone.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/',
    name: '1to1OS',
    short_name: '1to1OS',
    description: 'Personal and Business in one system.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#f4f8ff',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
      { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    shortcuts: [
      {
        name: '1to1OS Personal',
        short_name: 'Personal',
        url: '/personal',
        icons: [{ src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' }],
      },
      {
        name: '1to1OS Business',
        short_name: 'Business',
        url: '/business',
        icons: [{ src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' }],
      },
    ],
  };
}
