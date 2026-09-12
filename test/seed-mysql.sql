-- The MySQL twin of test/seed.sql: same shapes, so the same tests can ask the
-- same questions of both engines.
drop table if exists orders;
drop table if exists docs;
drop table if exists audit_log;
drop view if exists order_totals;
drop table if exists customers;

create table customers (
  id          bigint not null auto_increment primary key,
  email       varchar(255) not null unique,
  full_name   varchar(255),
  balance     decimal(12,2) not null default 0,
  is_active   tinyint(1) not null default 1,
  signed_up   timestamp not null default current_timestamp,
  prefs       json,
  notes       text
);

create table orders (
  id          bigint not null auto_increment primary key,
  customer_id bigint not null,
  placed_at   timestamp not null default current_timestamp,
  total       decimal(12,2) not null,
  status      varchar(32) not null default 'pending',
  constraint orders_customer_fk foreign key (customer_id) references customers(id) on delete cascade
);

create index orders_customer_idx on orders (customer_id);

create view order_totals as
  select c.id as customer_id, c.email, count(o.id) as orders, coalesce(sum(o.total), 0) as spent
  from customers c left join orders o on o.customer_id = c.id
  group by c.id, c.email;

-- No primary key, to exercise the read-only path.
create table audit_log (
  at     timestamp not null default current_timestamp,
  actor  varchar(64),
  action varchar(255)
);

-- Values that do not fit in one grid cell, and a precision trap.
create table docs (
  id      bigint not null auto_increment primary key,
  label   varchar(64) not null,
  payload json,
  blob_col blob,
  body    text
);

insert into docs (label, payload, blob_col, body) values
  ('precision',
   '{"account":12345678901234567890,"amount":1.10,"ok":true,"tags":["a","b"],"empty":{}}',
   unhex('48656c6c6f2c20776f726c6421000102'),
   repeat('The quick brown fox jumps over the lazy dog. ', 60)),
  ('nested',
   '{"a":{"b":{"c":[1,2,3]}},"note":"has, commas {and} braces"}',
   unhex('deadbeef'),
   concat('line one', char(10), 'line two', char(10), 'line three')),
  ('empty bits', null, null, '');

-- 2500 customers, without a recursive CTE so this runs on MySQL 5.7 too.
drop procedure if exists seed_customers;
delimiter //
create procedure seed_customers()
begin
  declare g int default 1;
  while g <= 2500 do
    insert into customers (email, full_name, balance, prefs, notes) values (
      concat('user', g, '@example.com'),
      case when g % 7 = 0 then null else concat('Customer ', g) end,
      round(rand() * 900, 2),
      json_object('tier', case when g % 3 = 0 then 'gold' else 'basic' end, 'n', g),
      case when g % 5 = 0 then concat('multi', char(10), 'line', char(10), 'note') else null end
    );
    set g = g + 1;
  end while;
end //
delimiter ;
call seed_customers();
drop procedure seed_customers;

drop procedure if exists seed_orders;
delimiter //
create procedure seed_orders()
begin
  declare g int default 1;
  while g <= 8000 do
    insert into orders (customer_id, total, status) values (
      floor(rand() * 2499) + 1,
      round(rand() * 400 + 5, 2),
      elt(floor(rand() * 4) + 1, 'pending', 'paid', 'shipped', 'refunded')
    );
    set g = g + 1;
  end while;
end //
delimiter ;
call seed_orders();
drop procedure seed_orders;

insert into audit_log (actor, action)
select 'system', concat('boot ', id) from customers limit 20;

analyze table customers, orders, docs, audit_log;
