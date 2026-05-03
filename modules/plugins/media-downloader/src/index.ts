import { registerPlugin } from '@capacitor/core';

import type { MediaDownloaderPlugin } from './definitions';

const MediaDownloader = registerPlugin<MediaDownloaderPlugin>('MediaDownloader', {
  web: () => import('./web').then((m) => new m.MediaDownloaderWeb()),
});

export * from './definitions';
export { MediaDownloader };
