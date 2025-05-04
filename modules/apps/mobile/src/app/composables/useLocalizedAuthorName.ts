import { Author } from '@lectorium/dal/models'
import { useConfig } from './useConfig'

export function useLocalizedAuthorName() {
  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const config = useConfig()

  /* -------------------------------------------------------------------------- */
  /*                                   Helpers                                  */
  /* -------------------------------------------------------------------------- */

  function t(
    author: Author,
    type: 'fullName' = 'fullName'
  ): string {
    return author[type][config.appLanguage.value] 
        || author[type].en
        || author._id.replace('author::', '')
  }

  /* -------------------------------------------------------------------------- */
  /*                                  Interface                                 */
  /* -------------------------------------------------------------------------- */

  return t
}