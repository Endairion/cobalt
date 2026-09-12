drop schema if exists shop cascade;
create schema shop;

create table shop.customers (
  id          bigint generated always as identity primary key,
  email       text not null unique,
  full_name   text,
  balance     numeric(12,2) not null default 0,
  is_active   boolean not null default true,
  signed_up   timestamptz not null default now(),
  prefs       jsonb,
  notes       text
);

create table shop.orders (
  id          bigint generated always as identity primary key,
  customer_id bigint not null references shop.customers(id) on delete cascade,
  placed_at   timestamptz not null default now(),
  total       numeric(12,2) not null,
  status      text not null default 'pending'
);

create index on shop.orders (customer_id);

create view shop.order_totals as
  select c.id as customer_id, c.email, count(o.id) as orders, coalesce(sum(o.total),0) as spent
  from shop.customers c left join shop.orders o on o.customer_id = c.id
  group by 1,2;

-- a table with no primary key, to exercise the read-only path
create table shop.audit_log (
  at       timestamptz not null default now(),
  actor    text,
  action   text
);

-- Values the grid cannot show in one line: binary, a big document, long prose.
-- The bigint and the trailing zero in `payload` are there to catch a formatter
-- that round-trips JSON through parse/stringify.
create table shop.docs (
  id       bigint generated always as identity primary key,
  label    text not null,
  payload  jsonb,
  blob     bytea,
  body     text
);

insert into shop.docs (label, payload, blob, body) values
  ('precision',
   '{"account":12345678901234567890,"amount":1.10,"ok":true,"tags":["a","b"],"empty":{}}'::jsonb,
   decode('48656c6c6f2c20776f726c6421000102', 'hex'),
   repeat('The quick brown fox jumps over the lazy dog. ', 60)),
  ('nested',
   '{"a":{"b":{"c":[1,2,3]}},"note":"has, commas {and} braces"}'::jsonb,
   decode('deadbeef', 'hex'),
   E'line one
line two
line three'),
  ('empty bits', null, null, '');

insert into shop.customers (email, full_name, balance, prefs, notes)
select
  'user' || g || '@example.com',
  case when g % 7 = 0 then null else 'Customer ' || g end,
  round((random() * 900)::numeric, 2),
  jsonb_build_object('tier', case when g % 3 = 0 then 'gold' else 'basic' end, 'n', g),
  case when g % 5 = 0 then E'multi\nline\nnote' else null end
from generate_series(1, 2500) g;

insert into shop.orders (customer_id, total, status)
select (random() * 2499)::int + 1, round((random() * 400 + 5)::numeric, 2),
       (array['pending','paid','shipped','refunded'])[(random()*3)::int + 1]
from generate_series(1, 8000);

insert into shop.audit_log (actor, action)
select 'system', 'boot ' || g from generate_series(1, 20) g;

analyze;
