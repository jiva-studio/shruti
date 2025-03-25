# Entities :: Track Schema

```json
{
  "_id": "a01v6uhj9dl1tojobpn47uza::track",
  "@type": "track",
  "version": 1,
  "title": {
    "ru": "Title in Russian",
    "en": "Title in English",
  },
  "location": "mayapur",
  "date": [1974, 10, 20],
  "file_size": 17668564,
  "duration": 2125,
  "author": "acbsp",
  "audio_url": {
    "original": "library/tracks/{track_id}/audio/original.mp3"
  },
  "references": [
    ["sb", 1, 8, 40]
  ],
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

## Version History
**Version 1**: Initial schema with support for multilingual titles, basic metadata, references, and language details.