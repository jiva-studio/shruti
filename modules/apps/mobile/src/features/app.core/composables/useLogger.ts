export type LoggerOptions = {
  module: string
}

export function useLogger({ module }: LoggerOptions) {

  /* -------------------------------------------------------------------------- */
  /*                                   Actions                                  */
  /* -------------------------------------------------------------------------- */

  function info(message: string) {
    console.log(`[LCT] ${module}: ${message}`)
  }

  function debug(message: string) {
    console.debug(`[LCT] ${module}: ${message}`)
  }

  function error(message: string) {
    console.error(`[LCT] ${module}: ${message}`)
  }

  /* -------------------------------------------------------------------------- */
  /*                                  Intefface                                 */
  /* -------------------------------------------------------------------------- */

  return {
    error,
    debug,
    info
  }
}