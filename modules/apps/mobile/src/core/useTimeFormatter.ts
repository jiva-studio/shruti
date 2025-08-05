export function useTimeFormatter() {

  function fromSeconds(seconds: number): string {
    const hours   = Math.floor(seconds / 3600)
    const minutes = Math.floor((seconds % 3600) / 60)
    const remainingSeconds = Math.floor(seconds % 60)

    const minutesStr = minutes.toString().padStart(2, '0')
    const secondsStr = remainingSeconds.toString().padStart(2, '0')

    return hours > 0 
      ? `${hours}:${minutesStr}:${secondsStr}`
      : `${minutesStr}:${secondsStr}`
  }

  return { fromSeconds }
}