# Entities :: Inbox Track Schema

## Version 1
Initial schema

```json
{
  "_id": "{hash(path)}",
  "version": 1,
  "trackId": "cm974coif00030clb1mri4fb6",
  "path": "BCaitanyaS_CC_Adi_Lila_01-36_-_Initiating_Guru_Instructing_Gurus_and_Disciples_-_2011-11-20_Bon_Accueil.mp3",
  "author": {
    "extracted": "BCaitanyaS",
    "normalized": "bcs",
  },
  "title": {
    "extracted": "Initiating Guru Instructing Gurus and Disciples",
    "normalized": "author_id",
  },
  "date": {
    "extracted": "20111120",
    "normalized": [2011, 11, 20]
  },
  "location": {
    "extracted": "Bon Accueil",
    "normalized": "bon-accueil",
  },
  "references": {
    "extracted": "CC Adi 1.36",
    "normalized": [
      "cc-adi",
      1,
      36
    ]
  }
}
```
