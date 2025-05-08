import { DownloaderService } from '../services/DownloaderService'

 const DOWNLOADER_SERVICE = new DownloaderService()
 
 export function useDownloaderService() {
  return DOWNLOADER_SERVICE
 }