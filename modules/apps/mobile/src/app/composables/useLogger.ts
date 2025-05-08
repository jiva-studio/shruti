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

  /* -------------------------------------------------------------------------- */
  /*                                  Intefface                                 */
  /* -------------------------------------------------------------------------- */

  return {
    info
  }
}