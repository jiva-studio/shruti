import { WebPlugin } from '@capacitor/core';

import type { 
  DownloadCompleteEvent, DownloaderPlugin, DownloadRequest, DownloadResponse, 
  GetStatusResponse 
} from './definitions';

export class DownloaderWeb extends WebPlugin implements DownloaderPlugin {
  private callbacks: { [key: string]: (event: DownloadCompleteEvent) => void } = {};

  async enqueue(request: DownloadRequest): Promise<DownloadResponse> {
    console.log('Downloading: ', request.url);
    const taskId = Math.random().toString(36).substring(2, 15)
    setTimeout(() => {
      for (const callback of Object.values(this.callbacks)) {
        callback({ taskId, status: 'successful' })
      }
    }, 10000);
    return { taskId };
  }

  async getStatus(/*request: GetStatusRequest*/): Promise<GetStatusResponse> {
    return { status: 'successful' };
  }

  onDownloadComplete(
    callback: (event: DownloadCompleteEvent) => void
  ): Promise<{ callbackId: string; }> {
    return new Promise((resolve) => {
      const callbackId = Math.random().toString(36).substring(2, 15);
      this.callbacks[callbackId] = callback;
      resolve({ callbackId });
    })
  }
}
