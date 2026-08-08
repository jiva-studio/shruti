-- A spelling folded past its alphabet, so a name can be found however it was
-- written. "Ватсала дас" and "Vatsala das" are one person and were two keys;
-- so were "Adi Gadadhar" and "Adi Gadadhara".
--
-- Beside the key, not instead of it. The fold drops what a form of address
-- carries, and "Govinda Swami" and "Govinda das" are two people who fold to one
-- string — so this is how a name is looked up, never who somebody is. A lookup
-- that lands on two people returns both, which the filter already allows for.
ALTER TABLE discovery.author_keys ADD COLUMN IF NOT EXISTS key_folded text;
CREATE INDEX IF NOT EXISTS author_keys_folded_idx ON discovery.author_keys (key_folded);
