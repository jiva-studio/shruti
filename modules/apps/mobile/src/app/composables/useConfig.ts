import { createGlobalState } from '@vueuse/core'
import { ref } from 'vue'

/**
 * Predefined readonly user token for API requests.
 */
// TODO: inject another token for production build
const READONLY_USER_TOKEN = 
  'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJyZWFkb25seSIsImlhdCI6MTc0NDk4' +
  'MjczOCwiZXhwIjozNzQ0OTg2MzM4LCJyb2xlcyI6WyJyZWFkb25seSJdfQ.FUHE5gM6cI7H-RzsfM' +
  'KkY7njS0fpW2zDdROIsK7BV4eYf1_eTbgivElHovjOWBpw5Z4ogBC72VVPdTXiABePl4GyBtNLo3d' +
  'ygjWABCtnju8YVUwzEoMgMcAeghcb8vVN8JuRwc5HRvjrEc5-FsGg0W8qkAl5I4NxyPj8lnpPMrvg' +
  'nbnVMzNfxHMk4LiV9F-sRCyj2ew1sH_lzRQxTddEUqQHWQypZrXHkeZ2s07HQbHQMe_iAlT0BBiD-' +
  '7BlW3ycZIuxAkQhj2nF-9AnqFxUwjk7TdNOeKDW1xkQSkHaaqLy51PXe-R7ZkBpcxgSKF4Qwa3bNv' +
  'TKgOCQdQeje3WvZg'

export const useConfig = createGlobalState(() => {
  const appLanguage  = ref('en')
  const databaseUrl  = ref('http://localhost:5984')
  const apiUrl       = ref('http://localhost:8001')
  const authToken    = ref(READONLY_USER_TOKEN)
  const bucketName   = ref('lectorium-dev')

  return {
    appLanguage,
    apiUrl,
    databaseUrl,
    authToken,
    bucketName
  }
})
