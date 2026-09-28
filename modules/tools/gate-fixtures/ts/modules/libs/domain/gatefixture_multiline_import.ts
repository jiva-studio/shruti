// Known violation: the domain reaches the application layer through an import
// spread over several lines.
import {
  addTrackToPlaylist,
} from "@usecases"

export const fixture = addTrackToPlaylist
