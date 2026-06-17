import { markRaw, type Component } from "vue"

import {
  AnnotationIcon,
  BellIcon,
  BookIcon,
  DatabaseExportIcon,
  FlameIcon,
  HeadphonesIcon,
  IconDownload,
  IconPlay,
  IconRosetteDiscountCheckFilled,
  IconSearch,
  IconSettings,
  MessageIcon,
  TranscriptIcon,
  TrashIcon,
} from "@ui/icons/index.js"

import HelpIndicatorsPage from "./components/HelpIndicatorsPage.vue"

// Help articles are authored as markdown under `modules/docs/help/`
// (the single source of truth shared with the chat service), one file
// per page per locale: `<page-id>.<locale>.md`. Bulk-import them all as
// raw strings instead of listing ~200 explicit imports — adding a new
// locale or page is then just a matter of dropping in the `.md` file.
const HELP_RAW = import.meta.glob("@docs/help/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>

/**
 * Collect every translated body for one page id into a `{ locale: body }`
 * map by parsing the `<page-id>.<locale>.md` filename. Format-agnostic
 * about the glob key prefix (alias / relative / absolute).
 */
function pageLocales(id: HelpPageId): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [path, raw] of Object.entries(HELP_RAW)) {
    const file = path.split("/").pop() ?? ""
    const match = file.match(/^(.*)\.([A-Za-z-]+)\.md$/)
    if (match && match[1] === id) out[match[2]] = raw
  }
  return out
}

export type HelpPageId =
  | "what-is-sadhana"
  | "finding-lectures"
  | "playlist"
  | "activity-tracker"
  | "chat-ask-sadhu"
  | "transcripts"
  | "notes"
  | "notifications"
  | "player-controls"
  | "indicators"
  | "settings-overview"
  | "subscription"
  | "smart-library"
  | "export-import"
  | "delete-account"

export type HelpCategoryId = "features" | "settings" | "data"

interface HelpPageBase {
  id: HelpPageId
  icon: Component
}

export interface HelpMarkdownPage extends HelpPageBase {
  type: "markdown"
  /** Article body per locale code (e.g. `en`, `ru`, `sr-Cyrl`). */
  locales: Record<string, string>
}

export interface HelpComponentPage extends HelpPageBase {
  type: "component"
  component: Component
}

export type HelpPage = HelpMarkdownPage | HelpComponentPage

export interface HelpCategory {
  id: HelpCategoryId
  pages: HelpPage[]
}

export const helpManifest: HelpCategory[] = [
  {
    id: "features",
    pages: [
      {
        id: "what-is-sadhana",
        type: "markdown",
        icon: markRaw(BookIcon),
        locales: pageLocales("what-is-sadhana"),
      },
      {
        id: "finding-lectures",
        type: "markdown",
        icon: markRaw(IconSearch),
        locales: pageLocales("finding-lectures"),
      },
      {
        id: "playlist",
        type: "markdown",
        icon: markRaw(HeadphonesIcon),
        locales: pageLocales("playlist"),
      },
      {
        id: "chat-ask-sadhu",
        type: "markdown",
        icon: markRaw(MessageIcon),
        locales: pageLocales("chat-ask-sadhu"),
      },
      {
        id: "player-controls",
        type: "markdown",
        icon: markRaw(IconPlay),
        locales: pageLocales("player-controls"),
      },
      {
        id: "transcripts",
        type: "markdown",
        icon: markRaw(TranscriptIcon),
        locales: pageLocales("transcripts"),
      },
      {
        id: "notes",
        type: "markdown",
        icon: markRaw(AnnotationIcon),
        locales: pageLocales("notes"),
      },
      {
        id: "activity-tracker",
        type: "markdown",
        icon: markRaw(FlameIcon),
        locales: pageLocales("activity-tracker"),
      },
      {
        id: "notifications",
        type: "markdown",
        icon: markRaw(BellIcon),
        locales: pageLocales("notifications"),
      },
      {
        id: "indicators",
        type: "component",
        icon: markRaw(IconRosetteDiscountCheckFilled),
        component: markRaw(HelpIndicatorsPage),
      },
    ],
  },
  {
    id: "settings",
    pages: [
      {
        id: "settings-overview",
        type: "markdown",
        icon: markRaw(IconSettings),
        locales: pageLocales("settings-overview"),
      },
      {
        id: "subscription",
        type: "markdown",
        icon: markRaw(IconRosetteDiscountCheckFilled),
        locales: pageLocales("subscription"),
      },
      {
        id: "smart-library",
        type: "markdown",
        icon: markRaw(IconDownload),
        locales: pageLocales("smart-library"),
      },
      {
        id: "delete-account",
        type: "markdown",
        icon: markRaw(TrashIcon),
        locales: pageLocales("delete-account"),
      },
    ],
  },
  {
    id: "data",
    pages: [
      {
        id: "export-import",
        type: "markdown",
        icon: markRaw(DatabaseExportIcon),
        locales: pageLocales("export-import"),
      },
    ],
  },
]

export function findHelpPage(id: HelpPageId): HelpPage | undefined {
  for (const cat of helpManifest) {
    const page = cat.pages.find((p) => p.id === id)
    if (page) return page
  }
  return undefined
}
