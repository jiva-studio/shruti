/**
 * Reads a stream into a Blob with progress tracking
 * @param reader - ReadableStream reader
 * @param total - Total content length (0 if unknown)
 * @param onProgress - Progress callback
 * @returns Blob containing all read data
 */
async function readStreamToBlob(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  total: number,
  onProgress: (receivedLength: number, totalLength: number) => void
): Promise<Blob> {
  const chunks: Uint8Array[] = []
  let receivedLength = 0

  let done = false
  while (!done) {
    const result = await reader.read()
    done = result.done

    if (!done && result.value) {
      chunks.push(result.value)
      receivedLength += result.value.length

      onProgress(receivedLength, total)
    }
  }

  return new Blob(chunks as BlobPart[], { type: "application/vnd.sqlite3" })
}

/**
 * Downloads a file from a URL with progress tracking
 * @param url - URL to download from
 * @param onProgress - Progress callback
 * @returns Downloaded file as a Blob
 * @throws Error if download fails or response body is unavailable
 */
export async function downloadWithProgress(
  url: string,
  onProgress: (receivedLength: number, totalLength: number) => void
): Promise<Blob> {
  const response = await fetch(url)

  if (!response.ok) {
    throw new Error(`Failed to download file: ${response.statusText}`)
  }

  if (!response.body) {
    throw new Error("Response body is not available")
  }

  const contentLength = response.headers.get("content-length")
  const total = contentLength ? parseInt(contentLength, 10) : 0

  const reader = response.body.getReader()

  return readStreamToBlob(reader, total, onProgress)
}
