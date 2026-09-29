package catalogdb

// The published library.db schema, statement by statement, exactly as
// sqlite_master holds it in the file readers download.

const (
	ddlLibraryTableLibraryAttributionNotes = `CREATE TABLE library_attribution_notes (
			attribution_id TEXT NOT NULL REFERENCES library_attributions(id) ON DELETE CASCADE,
			language       TEXT NOT NULL,
			note           TEXT NOT NULL,
			PRIMARY KEY (attribution_id, language)
		)`

	ddlLibraryTableLibraryAttributionRefs = `CREATE TABLE "library_attribution_refs" (
			attribution_id TEXT NOT NULL REFERENCES library_attributions(id) ON DELETE CASCADE,
			ref_kind       TEXT NOT NULL,
			target_id      TEXT NOT NULL,
			position       INTEGER NOT NULL DEFAULT 0, language TEXT,
			PRIMARY KEY (attribution_id, ref_kind, target_id)
		)`

	ddlLibraryTableLibraryAttributionTriggers = `CREATE TABLE "library_attribution_triggers" (
			attribution_id TEXT NOT NULL REFERENCES library_attributions(id) ON DELETE CASCADE,
			language       TEXT NOT NULL,
			text           TEXT NOT NULL,
			PRIMARY KEY (attribution_id, language, text)
		)`

	ddlLibraryTableLibraryAttributions = `CREATE TABLE "library_attributions" (
			id          TEXT PRIMARY KEY,
			kind        TEXT NOT NULL CHECK (kind IN ('pinned', 'boost', 'memory')),
			created_at  TIMESTAMP NOT NULL,
			updated_at  TIMESTAMP NOT NULL
		)`

	ddlLibraryTableLibraryDocumentVariants = `CREATE TABLE library_document_variants (
  document_id TEXT NOT NULL REFERENCES library_documents(id),
  language    TEXT NOT NULL,
  title       TEXT,
  body        TEXT NOT NULL,
  PRIMARY KEY (document_id, language)
)`

	ddlLibraryTableLibraryDocuments = `CREATE TABLE library_documents (
  id        TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  tokens    TEXT NOT NULL,
  author_id TEXT NOT NULL,
  kind      TEXT NOT NULL,
  date      TEXT,
  UNIQUE (source_id, kind, tokens, author_id)
)`

	ddlLibraryTableLibraryMedia = `CREATE TABLE library_media (
			id         TEXT PRIMARY KEY,
			lang       TEXT NOT NULL,
			title      TEXT NOT NULL,
			text       TEXT NOT NULL,
			context    TEXT,
			embed_text TEXT,
			url        TEXT NOT NULL,
			type       TEXT NOT NULL,
			meta       TEXT
		)`

	ddlLibraryTableLibraryTitles = `CREATE TABLE library_titles (
  source_id TEXT NOT NULL,
  tokens    TEXT NOT NULL,
  language  TEXT NOT NULL,
  title     TEXT NOT NULL,
  PRIMARY KEY (source_id, tokens, language)
)`

	ddlLibraryTableLibraryVerseTranslations = `CREATE TABLE library_verse_translations (
  id          TEXT PRIMARY KEY,
  verse_id    TEXT NOT NULL REFERENCES library_verses(id),
  language    TEXT NOT NULL,
  translation TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'canonical',
  author_id   TEXT,
  note        TEXT,
  label       TEXT
)`

	ddlLibraryTableLibraryVerseTransliterations = `CREATE TABLE library_verse_transliterations (
  verse_id TEXT NOT NULL REFERENCES library_verses(id),
  language TEXT NOT NULL,
  text     TEXT NOT NULL,
  PRIMARY KEY (verse_id, language)
)`

	ddlLibraryTableLibraryVerseWords = `CREATE TABLE library_verse_words (
  id                  TEXT PRIMARY KEY,
  translation_id      TEXT NOT NULL REFERENCES library_verse_translations(id),
  sort_order          INTEGER NOT NULL,
  surface_form        TEXT NOT NULL,
  surface_translation TEXT NOT NULL,
  UNIQUE (translation_id, sort_order)
)`

	ddlLibraryTableLibraryVerses = `CREATE TABLE library_verses (
  id              TEXT PRIMARY KEY,
  source_id       TEXT NOT NULL,
  tokens          TEXT NOT NULL,
  text            TEXT,
  transliteration TEXT, audio_path TEXT,
  UNIQUE (source_id, tokens)
)`

	ddlLibraryIndexLibraryAttrRefsByTarget = `CREATE INDEX library_attr_refs_by_target
			ON library_attribution_refs(ref_kind, target_id)`

	ddlLibraryIndexLibraryAttributionsByKind = `CREATE INDEX library_attributions_by_kind
			ON library_attributions(kind)`

	ddlLibraryIndexLibraryDocumentsByAuthor = `CREATE INDEX library_documents_by_author ON library_documents(author_id)`

	ddlLibraryIndexLibraryDocumentsByKind = `CREATE INDEX library_documents_by_kind   ON library_documents(kind)`

	ddlLibraryIndexLibraryDocumentsByPos = `CREATE INDEX library_documents_by_pos    ON library_documents(source_id, tokens)`

	ddlLibraryIndexLibraryMediaByLang = `CREATE INDEX library_media_by_lang ON library_media(lang)`

	ddlLibraryIndexLibraryVerseTrByKind = `CREATE UNIQUE INDEX library_verse_tr_by_kind ON library_verse_translations(verse_id, language, kind)`

	ddlLibraryIndexLibraryVerseTrByVerse = `CREATE INDEX library_verse_tr_by_verse ON library_verse_translations(verse_id, language)`

	ddlLibraryViewLibraryVerseVariants = `CREATE VIEW library_verse_variants AS SELECT verse_id, language, translation FROM library_verse_translations WHERE kind='canonical'`
)

var libraryBaseline = []string{
	ddlLibraryTableLibraryAttributionNotes,
	ddlLibraryTableLibraryAttributionRefs,
	ddlLibraryTableLibraryAttributionTriggers,
	ddlLibraryTableLibraryAttributions,
	ddlLibraryTableLibraryDocumentVariants,
	ddlLibraryTableLibraryDocuments,
	ddlLibraryTableLibraryMedia,
	ddlLibraryTableLibraryTitles,
	ddlLibraryTableLibraryVerseTranslations,
	ddlLibraryTableLibraryVerseTransliterations,
	ddlLibraryTableLibraryVerseWords,
	ddlLibraryTableLibraryVerses,
	ddlLibraryIndexLibraryAttrRefsByTarget,
	ddlLibraryIndexLibraryAttributionsByKind,
	ddlLibraryIndexLibraryDocumentsByAuthor,
	ddlLibraryIndexLibraryDocumentsByKind,
	ddlLibraryIndexLibraryDocumentsByPos,
	ddlLibraryIndexLibraryMediaByLang,
	ddlLibraryIndexLibraryVerseTrByKind,
	ddlLibraryIndexLibraryVerseTrByVerse,
	ddlLibraryViewLibraryVerseVariants,
}
