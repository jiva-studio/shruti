import { nanoid } from "nanoid"

/**
 * Build a typed-prefix id factory shared by SQL repositories. Keeps the
 * `prefix_<12char>` shape consistent across `note_*`, `playlist_*`,
 * `media_*` etc.; if the format ever changes (length, alphabet, uuid),
 * one edit covers every entity type.
 */
export const createIdGenerator = (prefix: string) => (): string => `${prefix}_${nanoid(12)}`
