-- Reverse 0032: drop the lexical indexes. The pg_trgm extension is left in
-- place (other objects may rely on it; dropping an extension is rarely what a
-- rollback wants).
DROP INDEX IF EXISTS chunks_addr_trgm;
DROP INDEX IF EXISTS chunks_tsv_russian;
DROP INDEX IF EXISTS chunks_tsv_simple;
