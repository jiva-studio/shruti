# Dictionary Collection Schema
This document describes the schema for a dictionary collection in a database. 

## Author

```json
{
  "_id": "author::{id}",
  "type": "author",
  "version": 1,
  "fullName": {
    "en": "Author Name",
    "es": "Nombre del Autor" 
  }
}
```

## Location

```json
{
  "_id": "location::{id}",
  "type": "location",
  "version": 1,
  "fullName": {
    "en": "Location Name",
    "es": "Nombre de la Ubicación"
  }
}
```


## Source

```json
{
  "_id": "source::{id}",
  "type": "source",
  "version": 1,
  "fullName": {
    "en": "Bhagavad Gita",
    "es": "Bhagavad Gita",
    "rs": "Бхагавад Гита",
  },
  "shortName": {
    "en": "BG",
    "es": "BG",
    "rs": "БГ"
  },
}
```

## Language

```json
{
  "_id": "language::{id}",
  "type": "language",
  "version": 1,
  "code": "en",
  "fullName": "English",
  "icon": "🇺🇸"
}
```
