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
}

export interface DownloaderPlugin {
  enqueue(request: DownloadRequest): Promise<DownloadResponse>;
  getStatus(request: GetStatusRequest): Promise<GetStatusResponse>;
}
