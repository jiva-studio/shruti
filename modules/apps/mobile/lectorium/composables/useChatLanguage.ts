import { type Ref } from "vue"
import { useConfig } from "@lectorium/composables/useConfig.js"

/**
 * The chat answer language (`settings.chatLanguage`). Distinct from the
 * UI language: the user can have a Russian interface but ask the chat to
 * answer in another language. Default is the empty string, which the
 * read site interprets as "follow the interface language" — see
 * `chatLanguage.value || appLanguage.value` at the call sites.
 *
 * `lang` is opaque to the backend (it threads the code straight into its
 * prompts), so any locale code the languages repo offers is valid here.
 */
export function useChatLanguage(): Ref<string> {
  return useConfig<string>("settings.chatLanguage", "")
}

/**
 * Whether to machine-translate verbatim citations into the chat answer
 * language when no native version exists (`settings.chatTranslateCitations`).
 * Default ON — a non-corpus answer language (uk/sr) reads consistently when
 * the quotes are translated too; the server ships `mt: true` plus the
 * original text so the card offers an original/translated toggle. Users who
 * prefer source-language quotes can turn it off.
 */
export function useChatTranslateCitations(): Ref<boolean> {
  return useConfig<boolean>("settings.chatTranslateCitations", true)
}
