import type { LanguageCode, TopicId, TrackId } from "./core.js"

/**
 * One playable "daily wisdom" fragment: a short excerpt of a lecture, tied to
 * a topic. The daily-wisdom proactive rule samples one of these for a topic
 * the user picked and posts it into chat as a playable cite.
 */
export interface DailyWisdom {
  readonly id: string
  readonly trackId: TrackId
  readonly language: LanguageCode
  /** Fragment bounds in milliseconds. */
  readonly startMs: number
  readonly endMs: number
  /** The excerpt / aphorism text shown in chat. */
  readonly text: string
  readonly topicId: TopicId
}
