import { markRaw, type Component } from "vue"

import {
  BellIcon,
  BookIcon,
  DatabaseExportIcon,
  FlameIcon,
  IconDownload,
  IconPlay,
  IconRosetteDiscountCheckFilled,
  IconSettings,
} from "@ui/icons/index.js"

import HelpIndicatorsPage from "./components/HelpIndicatorsPage.vue"

import sadhanaEn from "@docs/help/what-is-sadhana.en.md?raw"
import sadhanaRu from "@docs/help/what-is-sadhana.ru.md?raw"
import activityEn from "@docs/help/activity-tracker.en.md?raw"
import activityRu from "@docs/help/activity-tracker.ru.md?raw"
import notificationsEn from "@docs/help/notifications.en.md?raw"
import notificationsRu from "@docs/help/notifications.ru.md?raw"
import playerControlsEn from "@docs/help/player-controls.en.md?raw"
import playerControlsRu from "@docs/help/player-controls.ru.md?raw"
import settingsOverviewEn from "@docs/help/settings-overview.en.md?raw"
import settingsOverviewRu from "@docs/help/settings-overview.ru.md?raw"
import smartLibraryEn from "@docs/help/smart-library.en.md?raw"
import smartLibraryRu from "@docs/help/smart-library.ru.md?raw"
import exportImportEn from "@docs/help/export-import.en.md?raw"
import exportImportRu from "@docs/help/export-import.ru.md?raw"

export type HelpPageId =
  | "what-is-sadhana"
  | "activity-tracker"
  | "notifications"
  | "player-controls"
  | "indicators"
  | "settings-overview"
  | "smart-library"
  | "export-import"

export type HelpCategoryId = "features" | "settings" | "data"

interface HelpPageBase {
  id: HelpPageId
  icon: Component
}

export interface HelpMarkdownPage extends HelpPageBase {
  type: "markdown"
  en: string
  ru: string
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
        en: sadhanaEn,
        ru: sadhanaRu,
      },
      {
        id: "activity-tracker",
        type: "markdown",
        icon: markRaw(FlameIcon),
        en: activityEn,
        ru: activityRu,
      },
      {
        id: "notifications",
        type: "markdown",
        icon: markRaw(BellIcon),
        en: notificationsEn,
        ru: notificationsRu,
      },
      {
        id: "player-controls",
        type: "markdown",
        icon: markRaw(IconPlay),
        en: playerControlsEn,
        ru: playerControlsRu,
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
        en: settingsOverviewEn,
        ru: settingsOverviewRu,
      },
      {
        id: "smart-library",
        type: "markdown",
        icon: markRaw(IconDownload),
        en: smartLibraryEn,
        ru: smartLibraryRu,
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
        en: exportImportEn,
        ru: exportImportRu,
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
