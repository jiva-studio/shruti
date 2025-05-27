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

  /* -------------------------------------------------------------------------- */
  /*                                  Intefface                                 */
  /* -------------------------------------------------------------------------- */

  return {
    debug,
    info
  }
}