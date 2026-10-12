-- staging.raw_trips -> staging.clean_trips + staging.rejected_trips
-- Every rule here is documented in CLAUDE.md ("Cleaning rules") and DESIGN.md.

-- 1. Assumptions about the raw data. Fail loudly rather than round, truncate or misparse.
DO $$
DECLARE n bigint;
BEGIN
    -- Amounts and miles are loaded into numeric(_, 2): refuse anything that would be rounded.
    SELECT count(*) INTO n FROM staging.raw_trips
    WHERE fare::numeric       <> round(fare::numeric, 2)
       OR tips::numeric       <> round(tips::numeric, 2)
       OR tolls::numeric      <> round(tolls::numeric, 2)
       OR extras::numeric     <> round(extras::numeric, 2)
       OR trip_total::numeric <> round(trip_total::numeric, 2)
       OR trip_miles::numeric <> round(trip_miles::numeric, 2);
    IF n > 0 THEN RAISE EXCEPTION 'clean: % rows have amounts or miles with more than 2 decimals', n; END IF;

    -- dim_time has 96 fifteen-minute slots: every start timestamp must sit on a slot boundary.
    SELECT count(*) INTO n FROM staging.raw_trips
    WHERE trip_start_timestamp IS NULL
       OR date_trunc('minute', trip_start_timestamp::timestamp) <> trip_start_timestamp::timestamp
       OR extract(minute FROM trip_start_timestamp::timestamp)::int % 15 <> 0;
    IF n > 0 THEN RAISE EXCEPTION 'clean: % rows have a missing or non-15-minute start timestamp', n; END IF;

    SELECT count(*) INTO n FROM staging.raw_trips
    WHERE taxi_id <> 'NA' AND taxi_id !~ '^[0-9a-f]{128}$';
    IF n > 0 THEN RAISE EXCEPTION 'clean: % rows have an unexpected taxi_id format', n; END IF;

    SELECT count(*) INTO n FROM staging.raw_trips
    WHERE trip_id !~ '^[0-9a-f]{40}$' OR payment_type IS NULL OR company IS NULL;
    IF n > 0 THEN RAISE EXCEPTION 'clean: % rows have a bad trip_id or missing payment_type/company', n; END IF;
END $$;

-- 2. Type every row and assign the first failing rule, in the approved rule order.
CREATE TEMP TABLE typed AS
SELECT
    r.trip_id,
    NULLIF(r.taxi_id, 'NA')                      AS taxi_hash,
    r.trip_start_timestamp::timestamp            AS trip_start_timestamp,
    r.trip_end_timestamp::timestamp              AS trip_end_timestamp,
    r.trip_seconds::integer                      AS trip_seconds,
    r.trip_miles::numeric(8,2)                   AS trip_miles,
    r.pickup_community_area::smallint            AS pickup_community_area,
    r.dropoff_community_area::smallint           AS dropoff_community_area,
    r.fare::numeric(10,2)                        AS fare,
    r.tips::numeric(10,2)                        AS tips,
    r.tolls::numeric(10,2)                       AS tolls,
    r.extras::numeric(10,2)                      AS extras,
    r.trip_total::numeric(10,2)                  AS trip_total,
    r.payment_type,
    r.company                                    AS company_raw,
    -- Canonical company: lowercase, drop '.' and ',', collapse whitespace, drop a trailing
    -- legal suffix. Merges e.g. "Taxicab Insurance Agency Llc" / ", LLC" / "  LLC".
    -- Hyphens are kept so owner-operator names like "2733 - 74600 Benny Jona" stay intact.
    regexp_replace(
        btrim(regexp_replace(regexp_replace(lower(r.company), '[.,]', '', 'g'), '\s+', ' ', 'g')),
        ' (llc|inc)$', '')                       AS company_canonical,
    CASE
        WHEN r.fare IS NULL OR r.tips IS NULL OR r.tolls IS NULL
          OR r.extras IS NULL OR r.trip_total IS NULL                      THEN 'null_amounts'
        WHEN r.trip_end_timestamp::timestamp < r.trip_start_timestamp::timestamp THEN 'end_before_start'
        WHEN r.trip_total::numeric > 1000                                  THEN 'trip_total_over_1000'
        WHEN r.trip_seconds::integer > 21600                               THEN 'trip_seconds_over_6h'
    END                                          AS reject_reason
FROM staging.raw_trips r;

-- 3. Split.
INSERT INTO staging.rejected_trips (trip_id, reason, source_file, raw)
SELECT t.trip_id, t.reject_reason, r.source_file, to_jsonb(r) - 'source_file'
FROM typed t
JOIN staging.raw_trips r USING (trip_id)
WHERE t.reject_reason IS NOT NULL;

INSERT INTO staging.clean_trips
SELECT trip_id, taxi_hash, trip_start_timestamp, trip_end_timestamp, trip_seconds, trip_miles,
       pickup_community_area, dropoff_community_area, fare, tips, tolls, extras, trip_total,
       payment_type, company_raw, company_canonical
FROM typed
WHERE reject_reason IS NULL;

DROP TABLE typed;
