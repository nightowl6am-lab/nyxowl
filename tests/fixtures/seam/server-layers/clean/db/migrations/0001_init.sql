-- Clean equivalent project: the client only references tables/functions that
-- the migrations define, so the db-query seam must come back GREEN.

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  display_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION get_user_count()
RETURNS integer AS 'SELECT count(*) FROM users'
LANGUAGE sql STABLE;
