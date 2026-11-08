create table invoices (
  id integer primary key,
  owner_id text not null,
  total_cents integer not null
);

create table users (
  id integer primary key,
  tenant_id text not null
);

alter table users enable row level security;

create policy users_read on users for select using (true);
