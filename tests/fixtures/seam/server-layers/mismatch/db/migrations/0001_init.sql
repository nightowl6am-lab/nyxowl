-- The mismatch project defines only the users table, but its client queries
-- reference a table and an rpc that no migration creates.

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  display_name TEXT NOT NULL
);
