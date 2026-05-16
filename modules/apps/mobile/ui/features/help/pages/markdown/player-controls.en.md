# Player gestures and controls

The floating player at the bottom of the screen is a 3-panel vertical
carousel. Swipe up or down between panels to switch what the player
exposes, tap the central play button to start or pause, and tap the
player body to open the transcript.

## Panels

- **Title (default).** The track title and author, with the primary
  play / pause control. This is what you see when the player first
  appears.
- **Speed (swipe up).** A horizontal slider for playback speed plus
  skip back / skip forward buttons.
- **Mix (swipe down).** A horizontal slider that collapses the stereo
  image to one ear — useful when listening through a single earbud
  or with lectures where the original language and a translation are
  on different channels.

The carousel locks the gesture direction after a short drag, so
horizontal interaction inside any inner slider does not accidentally
switch the panel. A swipe past about a quarter of the screen
commits to the next panel; shorter drags snap back.

## Playback speed

Drag the puck on the speed slider to scrub the speed. On release the
puck snaps to the nearest preset.

- Range: **0.5× – 2.0×**.
- Snap presets: **0.75×, 1.0×, 1.25×, 1.5×, 1.75×, 2.0×**.
- Default: **1.0×**.
- The pitch of the voice is preserved at all speeds.
- The chosen speed is saved across app restarts and applies to every
  track you play afterwards, until you change it again.

A live readout (e.g. "1.25×") appears while dragging, and a short
haptic tick fires when the puck crosses into a new preset zone.

## Mono balance (left / right)

The Mix panel exposes a single horizontal slider that collapses the
stereo image toward one ear.

- **Far left** — both ears hear the **left** channel only.
- **Centre (default)** — normal stereo, no processing.
- **Far right** — both ears hear the **right** channel only.

The centre has a small snap-back zone, so releasing near the middle
lands exactly on stereo and turns the processor off. Loudness is
compensated as you move the slider, so the perceived volume stays
steady. The chosen position is saved across app restarts.

## Tapping the player

Tapping outside the play button opens the **transcript** for the
currently playing track. Tapping again closes the transcript without
stopping playback.
