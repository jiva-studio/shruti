-- Reverse 0033: restore the question/topic kind vocabulary.
ALTER TABLE attributions DROP CONSTRAINT attributions_kind_check;
UPDATE attributions SET kind = 'question' WHERE kind = 'pinned';
UPDATE attributions SET kind = 'topic'    WHERE kind = 'boost';
ALTER TABLE attributions ADD CONSTRAINT attributions_kind_check CHECK (kind IN ('question', 'topic'));
