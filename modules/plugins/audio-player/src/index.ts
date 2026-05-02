import { registerPlugin } from '@capacitor/core';

import type { AudioPlayerPlugin } from './definitions';

const AudioPlayer = registerPlugin<AudioPlayerPlugin>('AudioPlayer', {
  web: () => import('./web').then((m) => new m.AudioPlayerPluginWeb()),
});

export * from './definitions';
export { AudioPlayer };
