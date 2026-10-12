-- Config C: the same star schema as sql/star/schema.sql, in DuckDB (columnar).
-- Same column names, types and nullability. No primary keys, foreign keys or indexes: DuckDB
-- would build ART indexes for them, which slow the load and are not used by aggregate scans
-- (DuckDB relies on per-row-group min/max zone maps instead). Integrity is guaranteed by the
-- source: these tables are copied row for row from config B, which enforces every constraint.

CREATE TABLE dim_date (
    date_key   INTEGER  NOT NULL,
    full_date  DATE     NOT NULL,
    year       SMALLINT NOT NULL,
    quarter    SMALLINT NOT NULL,
    month      SMALLINT NOT NULL,
    month_name VARCHAR  NOT NULL,
    iso_dow    SMALLINT NOT NULL,
    day_name   VARCHAR  NOT NULL,
    is_weekend BOOLEAN  NOT NULL
);

CREATE TABLE dim_time (
    time_key   SMALLINT NOT NULL,
    hour       SMALLINT NOT NULL,
    minute     SMALLINT NOT NULL,
    slot_label VARCHAR  NOT NULL
);

CREATE TABLE dim_company (
    company_key  SMALLINT NOT NULL,
    company_id   SMALLINT NOT NULL,
    company_name VARCHAR  NOT NULL
);

CREATE TABLE dim_payment (
    payment_key     SMALLINT NOT NULL,
    payment_type_id SMALLINT NOT NULL,
    payment_type    VARCHAR  NOT NULL
);

CREATE TABLE dim_area (
    area_key          SMALLINT NOT NULL,
    community_area_id SMALLINT,
    area_name         VARCHAR  NOT NULL
);

CREATE TABLE dim_taxi (
    taxi_key  INTEGER NOT NULL,
    taxi_hash VARCHAR
);

CREATE TABLE fact_trips (
    trip_id          VARCHAR       NOT NULL,
    date_key         INTEGER       NOT NULL,
    time_key         SMALLINT      NOT NULL,
    pickup_area_key  SMALLINT      NOT NULL,
    dropoff_area_key SMALLINT      NOT NULL,
    company_key      SMALLINT      NOT NULL,
    payment_key      SMALLINT      NOT NULL,
    taxi_key         INTEGER       NOT NULL,
    trip_seconds     INTEGER,
    trip_miles       DECIMAL(8,2),
    fare             DECIMAL(10,2) NOT NULL,
    tips             DECIMAL(10,2) NOT NULL,
    tolls            DECIMAL(10,2) NOT NULL,
    extras           DECIMAL(10,2) NOT NULL,
    trip_total       DECIMAL(10,2) NOT NULL
);
