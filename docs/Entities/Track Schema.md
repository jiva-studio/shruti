# Entities :: Track Schema

## Version 1
Initial schema with support for multilingual titles, basic metadata, references, and language details.

```json
{
  "_id": "{trackId}",
  "@type": "track",
  "version": 1,
  "location": "mayapur",
  "date": [1974, 10, 20],
  "author": "acbsp",
  "title": {
    "ru": "Title in Russian",
    "en": "Title in English",
  },
  "references": [
    ["sb", 1, 8, 40],
    ["sb", 1, 8, 41]
  ],
  "audio": {
    "original": {
      "path": "library/tracks/{trackId}/audio/original.mp3",
      "fileSize": 12345,
      "duration": 12345,
    }
  },
  "languages": [
    {
      "language": "ru",
      "source": "track",
      "type": "original"
    },
    {
      "language": "ru",
      "source": "transcript",
      "type": "generated"
    }
  ],
}
```
