import * as Sentry from '@sentry/capacitor'

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

  function error(message: string, error?: any) {
    console.error(`[LCT] ${module}: ${message}`)
    if (error) {
      const errorDetails = error.message || error.msg || '' 
      Sentry.captureException(
        new Error(message + (errorDetails ? `: ${errorDetails}` : ''), { cause: error }),
      )
    }
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