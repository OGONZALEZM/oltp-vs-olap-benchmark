-- Staging: raw landing table and rejection log. Rebuilt from scratch on every load.
DROP SCHEMA IF EXISTS staging CASCADE;
CREATE SCHEMA staging;

-- One row per API record, exactly as received: every value is text, absent fields are NULL.
-- UNLOGGED: it is fully reproducible from data/raw, so WAL would be wasted work.
-- The primary key is added after COPY (faster bulk load, same uniqueness guarantee).
CREATE UNLOGGED TABLE staging.raw_trips (
    trip_id                text NOT NULL,
    taxi_id                text,
    trip_start_timestamp   text,
    trip_end_timestamp     text,
    trip_seconds           text,
    trip_miles             text,
    pickup_community_area  text,
    dropoff_community_area text,
    fare                   text,
    tips                   text,
    tolls                  text,
    extras                 text,
    trip_total             text,
    payment_type           text,
    company                text,
    source_file            text NOT NULL   -- e.g. 2025-01/0003.ndjson.gz
);

-- Typed rows that passed every cleaning rule; input to the OLTP load.
CREATE UNLOGGED TABLE staging.clean_trips (
    trip_id                text PRIMARY KEY,
    taxi_hash              text,           -- NULL when the API sent the "NA" sentinel
    trip_start_timestamp   timestamp NOT NULL,
    trip_end_timestamp     timestamp,
    trip_seconds           integer,
    trip_miles             numeric(8,2),
    pickup_community_area  smallint,
    dropoff_community_area smallint,
    fare                   numeric(10,2) NOT NULL,
    tips                   numeric(10,2) NOT NULL,
    tolls                  numeric(10,2) NOT NULL,
    extras                 numeric(10,2) NOT NULL,
    trip_total             numeric(10,2) NOT NULL,
    payment_type           text NOT NULL,
    company_raw            text NOT NULL,
    company_canonical      text NOT NULL
);

-- Rows dropped by a cleaning rule. The first failing rule (in rule order) is the reason.
CREATE TABLE staging.rejected_trips (
    trip_id     text PRIMARY KEY,
    reason      text NOT NULL CHECK (reason IN (
                    'null_amounts', 'end_before_start', 'trip_total_over_1000', 'trip_seconds_over_6h')),
    source_file text NOT NULL,
    raw         jsonb NOT NULL
);
