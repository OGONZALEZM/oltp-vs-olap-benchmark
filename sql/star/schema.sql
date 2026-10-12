-- Config B: star schema in Postgres. Same logical DDL as sql/duckdb/schema.sql (config C).
-- Grain of fact_trips: one row per trip. Every dimension key is NOT NULL; a missing pickup/
-- dropoff area or taxi points at the "Unknown" member (key 0).
-- Foreign keys and indexes are added after the bulk load by constraints.sql.
DROP SCHEMA IF EXISTS star CASCADE;
CREATE SCHEMA star;

CREATE TABLE star.dim_date (
    date_key   integer PRIMARY KEY,          -- yyyymmdd
    full_date  date NOT NULL UNIQUE,
    year       smallint NOT NULL,
    quarter    smallint NOT NULL,
    month      smallint NOT NULL,
    month_name text NOT NULL,
    iso_dow    smallint NOT NULL,            -- 1 = Monday .. 7 = Sunday
    day_name   text NOT NULL,
    is_weekend boolean NOT NULL
);

-- 96 fifteen-minute slots; the source rounds every timestamp to a 15-minute boundary.
CREATE TABLE star.dim_time (
    time_key   smallint PRIMARY KEY,         -- hour * 4 + minute / 15, 0..95
    hour       smallint NOT NULL,
    minute     smallint NOT NULL,
    slot_label text NOT NULL                 -- 'HH:MM'
);

CREATE TABLE star.dim_company (
    company_key  smallint PRIMARY KEY,
    company_id   smallint NOT NULL UNIQUE,   -- natural key from oltp.companies
    company_name text NOT NULL
);

CREATE TABLE star.dim_payment (
    payment_key     smallint PRIMARY KEY,
    payment_type_id smallint NOT NULL UNIQUE,
    payment_type    text NOT NULL
);

-- Role-playing dimension: used as both pickup and dropoff area.
CREATE TABLE star.dim_area (
    area_key          smallint PRIMARY KEY,  -- 0 = Unknown / outside Chicago
    community_area_id smallint UNIQUE,       -- NULL only for the Unknown member
    area_name         text NOT NULL
);

CREATE TABLE star.dim_taxi (
    taxi_key  integer PRIMARY KEY,           -- 0 = Unknown
    taxi_hash text UNIQUE                    -- NULL only for the Unknown member
);

CREATE TABLE star.fact_trips (
    trip_id          text PRIMARY KEY,       -- degenerate dimension; also used to verify results
    date_key         integer  NOT NULL,
    time_key         smallint NOT NULL,
    pickup_area_key  smallint NOT NULL,
    dropoff_area_key smallint NOT NULL,
    company_key      smallint NOT NULL,
    payment_key      smallint NOT NULL,
    taxi_key         integer  NOT NULL,
    trip_seconds     integer,
    trip_miles       numeric(8,2),
    fare             numeric(10,2) NOT NULL,
    tips             numeric(10,2) NOT NULL,
    tolls            numeric(10,2) NOT NULL,
    extras           numeric(10,2) NOT NULL,
    trip_total       numeric(10,2) NOT NULL
);
