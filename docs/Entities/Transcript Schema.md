# Entities :: Transcript Schema

This document describes the JSON schema used to represent transcript data for a specific track, identified by a track_id, in a given language. The structure is designed to store timed text blocks (e.g., sentences) and organizational markers (e.g., paragraphs) associated with an audio or video track.

## Schema Overview

The JSON object consists of a unique identifier, a version number, and an array of blocks that represent the transcript content.

```json
{
  "_id": "{track_id}::transcript::{language}",
  "@type": "transcript",
  "version": 1,
  "blocks": [
    {
      "type": "sentence",
      "start": 10.108,
      "end": 20.123,
      "text": "Text"
    },
    {
      "type": "paragraph"
    }
  ]
}
```

## Version History
**Version 1**: Initial schema with support for sentence and paragraph block types.