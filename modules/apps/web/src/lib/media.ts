// Base URL for delivering track media (audio/video/covers/shares/pdf exports).
// Served by the Bunny.net CDN (US+EU edge); override per-environment with
// PUBLIC_SHRUTI_MEDIA_BASE_URL. Astro requires the PUBLIC_ prefix to expose
// the value to the client bundle.
export const MEDIA_BASE =
  (import.meta.env.PUBLIC_SHRUTI_MEDIA_BASE_URL as string | undefined)?.replace(/\/$/, '') ||
  'https://cdn.shruti.local'

export function resolveMediaUrl(path: string): string {
  if (!path) return ''
  return /^https?:\/\//.test(path) ? path : `${MEDIA_BASE}/${path.replace(/^\/+/, '')}`
}
