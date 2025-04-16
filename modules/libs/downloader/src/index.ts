import { registerPlugin } from '@capacitor/core';

import type { DownloaderPlugin } from './definitions';

const Downloader = registerPlugin<DownloaderPlugin>('Downloader', {
  web: () => import('./web').then((m) => new m.DownloaderWeb()),
});

export * from './definitions';
export { Downloader };
