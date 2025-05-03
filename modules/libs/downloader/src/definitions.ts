export type DownloadRequest = {
  url: string;
  destination: string;
  title: string;
}

export type DownloadResponse = {
  taskId: string;
}

export type GetStatusRequest = {
  taskId: string;
}

export type GetStatusResponse = {
  status: "successful" | "pending" | "paused" | "failed" | "running";
  progress: number;
}

export type DownloadCompleteEvent = {
  taskId: string
  status: "successful" | "failed"
}

export interface DownloaderPlugin {
  enqueue(request: DownloadRequest): Promise<DownloadResponse>;
  getStatus(request: GetStatusRequest): Promise<GetStatusResponse>;
  onDownloadComplete(
    callback: (event: DownloadCompleteEvent) => void
  ): Promise<{ callbackId: string }>
}
