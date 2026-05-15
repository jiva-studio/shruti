# Background Videos

Place your background video files in this folder.

Supported formats:
- `.mp4`
- `.mov`
- `.avi`
- `.mkv`
- `.webm`

The generator will:
1. Randomly select videos from this folder for each slide
2. Extract a random **video clip** (not static frame) matching the slide duration
3. Crop the clip from the center to fit the 1080x1920 reel format
4. Add a semi-transparent dark overlay (50% opacity) for better text readability
5. Overlay the animated text on top of the **playing video**

**Note:** The background videos will play during each slide, not be static images!

Example:
```
backgrounds/
  ├── nature-scene-1.mp4
  ├── city-timelapse.mp4
  └── abstract-motion.mov
```
