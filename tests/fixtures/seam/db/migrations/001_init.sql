CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  parent_id INTEGER,
  amount NUMERIC(10,2),
  note VARCHAR(255) CHECK (note <> ''),
  "display_name" TEXT,
  CONSTRAINT users_pk PRIMARY KEY (id)
);

CREATE TABLE categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE addresses (
  id TEXT PRIMARY KEY,
  street TEXT NOT NULL
);

CREATE TABLE statuses (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL
);

CREATE TABLE companies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE analyses (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL
);
