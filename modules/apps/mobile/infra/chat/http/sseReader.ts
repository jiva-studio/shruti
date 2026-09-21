import type { ChatStreamEvent } from "@lib/contracts"
import { findEventBoundary, parseSseBlock } from "./sseParser.js"

/** Three missed 15s keepalives. A half-open socket never delivers `done` and
 *  never errors, so without this the read waits forever. */
export const SSE_STALL_TIMEOUT_MS = 45_000

/** A read that outlived {@link SSE_STALL_TIMEOUT_MS}. Named so the stream's
 *  catch can't mistake it for the caller's abort. */
class SseStallError extends Error {
  readonly kind = "sse_stall"
  constructor(timeoutMs: number) {
    super(`SSE stalled: no data for ${timeoutMs}ms`)
    this.name = "SseStallError"
  }
}

/** Armed per read, so any byte restarts the window. */
async function readWithStallTimeout<T>(
  reader: { read: () => Promise<T> },
  timeoutMs: number
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new SseStallError(timeoutMs)), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** Reads past the terminal event, because `usage` arrives after it. A stall
 *  keeps `code: "stream"`: the store reads that one as a resumable drop. */
export async function* readSseStream(
  body: ReadableStream<Uint8Array>
): AsyncGenerator<ChatStreamEvent, void, void> {
  const reader = body.getReader()
  try {
    yield* pumpReader(reader)
  } catch (err) {
    if ((err as { name?: string })?.name === "AbortError") return
    yield {
      type: "error",
      code: "stream",
      message: err instanceof Error ? err.message : "Stream error",
    }
  } finally {
    try {
      await reader.cancel()
    } catch {
      // The reader may already be closed.
    }
  }
}

async function* pumpReader(
  reader: ReadableStreamDefaultReader<Uint8Array>
): AsyncGenerator<ChatStreamEvent, void, void> {
  const decoder = new TextDecoder()
  let buffer = ""
  let sawTerminal = false
  for (;;) {
    const { done, value } = await readWithStallTimeout(reader, SSE_STALL_TIMEOUT_MS)
    if (done) return
    buffer += decoder.decode(value, { stream: true })
    const { blocks, rest } = splitBlocks(buffer)
    buffer = rest
    for (const block of blocks) {
      const event = parseSseBlock(block)
      if (!event || (sawTerminal && event.type !== "usage")) continue
      yield event
      if (event.type === "done" || event.type === "error") sawTerminal = true
    }
  }
}

/** The complete frames in the buffer, and what is left of a partial one. */
function splitBlocks(buffer: string): { blocks: string[]; rest: string } {
  const blocks: string[] = []
  let boundary: number
  while ((boundary = findEventBoundary(buffer)) !== -1) {
    blocks.push(buffer.slice(0, boundary))
    // 2 for `\n\n`, 4 for `\r\n\r\n`.
    const skip = buffer.startsWith("\r\n\r\n", boundary) || buffer[boundary] === "\r" ? 4 : 2
    buffer = buffer.slice(boundary + skip)
  }
  return { blocks, rest: buffer }
}
