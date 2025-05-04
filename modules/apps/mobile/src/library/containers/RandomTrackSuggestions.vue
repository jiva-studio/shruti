<template>
  <template 
    v-for="author, idx in authors"
    :key="author.id"
  >
    <TrackSuggestionsSection
      :max="4"
      :title="authorName(author)"
      :selector="{ 'author': author._id.replace('author::', '') }"
      @loading="v => onComponentLoaded(v, idx)"
    />
  </template>
</template>


<script setup lang="ts">
import { watch, ref } from 'vue'
import { useDAL } from '@shruti/mobile/app'
import { useAsyncState } from '@vueuse/core'
import { type Author } from '@shruti/dal/models'
import { useRandomAuthors } from '@shruti/mobile/library/composables/useRandomAuthors'
import { useLocalizedAuthorName } from '@shruti/mobile/app/composables/useLocalizedAuthorName'
import TrackSuggestionsSection from '@shruti/mobile/library/containers/TrackSuggestionsSection.vue'

/* -------------------------------------------------------------------------- */
/*                                Dependencies                                */
/* -------------------------------------------------------------------------- */

const dal = useDAL()
const randomAuthors = useRandomAuthors()
const authorName = useLocalizedAuthorName()


/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

const props = defineProps<{
  maxAuthors: number
}>()

const emit = defineEmits<{
  (e: 'loading', value: boolean): void
}>()


/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

const componentsLoadingState = ref<boolean[]>([])

const { state: authors } = useAsyncState(
  async () => { 
    // TODO: shruti specific logic, extract to config
    const [acbsp, rest] = await Promise.all([
      dal.authors.findOne({ _id: 'author::acbsp' }),
      randomAuthors.get({ 
        max: props.maxAuthors, 
        selector: { _id: { $ne: 'author::acbsp' } } 
      })
    ])
    const authors = [acbsp, ...rest].filter(x => x !== undefined) as Author[]
    componentsLoadingState.value = Array(authors.length).fill(true)
    return authors
  }, [], { 
    immediate: true, 
    resetOnExecute: false,
  }
)

/* -------------------------------------------------------------------------- */
/*                                    Hooks                                   */
/* -------------------------------------------------------------------------- */

function onComponentLoaded(value: boolean, idx: number) {
  componentsLoadingState.value[idx] = value
}

/* -------------------------------------------------------------------------- */
/*                                    Hooks                                   */
/* -------------------------------------------------------------------------- */

watch(componentsLoadingState, (value: boolean[]) => {
  emit('loading', value.some(v => v === true))
}, { deep: true })
</script>
