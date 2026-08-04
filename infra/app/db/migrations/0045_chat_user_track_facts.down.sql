-- Drops the private-track metadata projection. Rebuilt from `track.ready`
-- redeliveries, so nothing authoritative is lost.

DROP TABLE IF EXISTS user_track_facts;
