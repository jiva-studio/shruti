/* -------------------------------------------------------------------------- */
/*                                   Russian                                  */
/* -------------------------------------------------------------------------- */

import ruApp from './ru/app'
import ruHome from './ru/home'
import ruLibrary from './ru/library'
import ruSearch from './ru/search'
import ruSettings from './ru/settings'
import ruNotes from './ru/notes'
import ruErrors from './ru/errors'

/* -------------------------------------------------------------------------- */
/*                                   English                                  */
/* -------------------------------------------------------------------------- */

import enApp from './en/app'
import enHome from './en/home'
import enLibrary from './en/library'
import enSearch from './en/search'
import enSettings from './en/settings'
import enNotes from './en/notes'
import enErrors from './en/errors'

/* -------------------------------------------------------------------------- */
/*                                   Export                                   */
/* -------------------------------------------------------------------------- */

export const locale = {
  ru: {
    app: ruApp,
    home: ruHome,
    library: ruLibrary,
    search: ruSearch,
    settings: ruSettings,
    notes: ruNotes,
    errors: ruErrors,
  },
  en: {
    app: enApp,
    home: enHome,
    library: enLibrary,
    search: enSearch,
    settings: enSettings,
    notes: enNotes,
    errors: enErrors,
  }
}