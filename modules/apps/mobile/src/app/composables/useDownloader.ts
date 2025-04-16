import { Downloader, DownloadRequest, DownloadResponse, GetStatusRequest, GetStatusResponse } from 'lectorium-downloader'

export function useDownloader() {
  async function enqueue(request: DownloadRequest): Promise<DownloadResponse> {
    return await Downloader.enqueue(request)
  }

  async function getStatus(request: GetStatusRequest): Promise<GetStatusResponse> {
    return await Downloader.getStatus(request)
  }

  return {
    enqueue,
    getStatus
  }
}