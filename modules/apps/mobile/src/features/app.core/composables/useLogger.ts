export type LoggerOptions = {
  module: string
}

export function useLogger({ module }: LoggerOptions) {

  /* -------------------------------------------------------------------------- */
  /*                                   Actions                                  */
  /* -------------------------------------------------------------------------- */

  function info(message: string) {
    console.log(`${module}: ${message}`)
  }

  function debug(message: string) {
    console.debug(`${module}: ${message}`)
  }

  function error(message: string) {
    console.error(`${module}: ${message}`)
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