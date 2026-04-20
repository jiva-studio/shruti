export { default as SelectorDialog } from "./SelectorDialog.vue"
export { default as ListItemsSelectorDialog } from "./ListItemsSelectorDialog.vue"
export { default as ListItemSelectorDialog } from "./ListItemSelectorDialog.vue"

export type SelectorDialogItem = { id: string; title: string }
export type ListItemSelectorItem = { id: string | undefined; title: string }
