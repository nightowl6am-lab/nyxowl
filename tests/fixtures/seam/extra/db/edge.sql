-- Schema with nested types, quoted identifiers, and escaped literals
CREATE TABLE IF NOT EXISTS "public"."order_items" (
  id TEXT PRIMARY KEY,
  "weird col" TEXT,
  amount NUMERIC(10,2),
  note TEXT CHECK (note <> 'a,b'),
  meta JSON DEFAULT '{"a":1}',
  escaped TEXT DEFAULT 'it\'s',
  CONSTRAINT order_items_pk PRIMARY KEY (id),
  UNIQUE (id)
);

CREATE TABLE no_semicolon (id INT)
