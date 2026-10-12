-- Config A: normalized OLTP model (3NF).
-- Tables are created with primary keys and CHECKs only; foreign keys and secondary indexes are
-- added after the bulk load by constraints.sql (same end state, much faster load).
DROP SCHEMA IF EXISTS oltp CASCADE;
CREATE SCHEMA oltp;

-- Names seeded from sql/seed/community_areas.csv (Boundaries - Community Areas, igwz-8jzy).
CREATE TABLE oltp.community_areas (
    community_area_id smallint PRIMARY KEY CHECK (community_area_id BETWEEN 1 AND 77),
    name              text NOT NULL UNIQUE
);

-- canonical_name is the dedup key (see staging cleaning); name is the most frequent raw spelling.
CREATE TABLE oltp.companies (
    company_id     smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    canonical_name text NOT NULL UNIQUE,
    name           text NOT NULL
);

CREATE TABLE oltp.payment_types (
    payment_type_id smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name            text NOT NULL UNIQUE
);

-- A taxi has no attributes beyond its anonymized id: 17% of taxis serve more than one company,
-- so company is an attribute of the trip, not of the taxi.
CREATE TABLE oltp.taxis (
    taxi_id   integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    taxi_hash text NOT NULL UNIQUE CHECK (taxi_hash ~ '^[0-9a-f]{128}$')
);

-- Census tracts and pickup/dropoff centroids are intentionally absent: they are functionally
-- determined by the community area (transitive dependencies) and tracts are ~55% suppressed.
CREATE TABLE oltp.trips (
    trip_id                   text PRIMARY KEY CHECK (trip_id ~ '^[0-9a-f]{40}$'),
    taxi_id                   integer,              -- NULL = unknown taxi
    company_id                smallint NOT NULL,
    payment_type_id           smallint NOT NULL,
    trip_start_timestamp      timestamp NOT NULL,   -- Chicago local time, no time zone
    trip_end_timestamp        timestamp,
    trip_seconds              integer CHECK (trip_seconds BETWEEN 0 AND 21600),
    trip_miles                numeric(8,2) CHECK (trip_miles >= 0),
    pickup_community_area_id  smallint,             -- NULL = outside Chicago / not reported
    dropoff_community_area_id smallint,
    fare                      numeric(10,2) NOT NULL CHECK (fare >= 0),
    tips                      numeric(10,2) NOT NULL CHECK (tips >= 0),
    tolls                     numeric(10,2) NOT NULL CHECK (tolls >= 0),
    extras                    numeric(10,2) NOT NULL CHECK (extras >= 0),
    trip_total                numeric(10,2) NOT NULL CHECK (trip_total BETWEEN 0 AND 1000),
    CHECK (trip_end_timestamp >= trip_start_timestamp)
);
