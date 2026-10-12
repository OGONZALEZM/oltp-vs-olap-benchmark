-- staging.clean_trips -> config A (oltp). oltp.community_areas is already seeded from CSV.
-- Text ordering uses COLLATE "C" so generated ids do not depend on the server locale.

INSERT INTO oltp.companies (canonical_name, name)
SELECT company_canonical,
       -- display name: the most frequent raw spelling of the canonical company
       (array_agg(company_raw ORDER BY n DESC, company_raw COLLATE "C"))[1]
FROM (
    SELECT company_canonical, company_raw, count(*) AS n
    FROM staging.clean_trips
    GROUP BY company_canonical, company_raw
) spellings
GROUP BY company_canonical
ORDER BY company_canonical COLLATE "C";

INSERT INTO oltp.payment_types (name)
SELECT payment_type FROM staging.clean_trips
GROUP BY payment_type
ORDER BY payment_type COLLATE "C";

INSERT INTO oltp.taxis (taxi_hash)
SELECT taxi_hash FROM staging.clean_trips
WHERE taxi_hash IS NOT NULL
GROUP BY taxi_hash
ORDER BY taxi_hash COLLATE "C";

-- Physical order (start timestamp, trip_id) is the same for oltp.trips, star.fact_trips and the
-- DuckDB fact table, so no config gets a clustering advantage over another.
INSERT INTO oltp.trips (
    trip_id, taxi_id, company_id, payment_type_id, trip_start_timestamp, trip_end_timestamp,
    trip_seconds, trip_miles, pickup_community_area_id, dropoff_community_area_id,
    fare, tips, tolls, extras, trip_total)
SELECT c.trip_id, tx.taxi_id, co.company_id, p.payment_type_id, c.trip_start_timestamp,
       c.trip_end_timestamp, c.trip_seconds, c.trip_miles, c.pickup_community_area,
       c.dropoff_community_area, c.fare, c.tips, c.tolls, c.extras, c.trip_total
FROM staging.clean_trips c
JOIN oltp.companies co     ON co.canonical_name = c.company_canonical
JOIN oltp.payment_types p  ON p.name = c.payment_type
LEFT JOIN oltp.taxis tx    ON tx.taxi_hash = c.taxi_hash
ORDER BY c.trip_start_timestamp, c.trip_id COLLATE "C";
