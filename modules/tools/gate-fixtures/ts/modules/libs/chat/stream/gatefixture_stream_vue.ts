// Known violation: the chat wire library, which runs outside Vue, imports it.
import { ref } from "vue"

export const fixture = ref(0)
