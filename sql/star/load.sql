-- config A (oltp) -> config B (star). Built from the OLTP tables so A and B hold the same rows.
-- Surrogate keys are generated deterministically (row_number over the natural key).

INSERT INTO star.dim_date
SELECT (extract(year FROM d) * 10000 + extract(month FROM d) * 100 + extract(day FROM d))::integer,
       d,
       extract(year FROM d)::smallint,
       extract(quarter FROM d)::smallint,
       extract(month FROM d)::smallint,
       to_char(d, 'FMMonth'),
       extract(isodow FROM d)::smallint,
       to_char(d, 'FMDay'),
       extract(isodow FROM d) IN (6, 7)
FROM (SELECT min(trip_start_timestamp)::date AS lo, max(trip_start_timestamp)::date AS hi FROM oltp.trips) b,
     generate_series(b.lo, b.hi, interval '1 day') AS g(day),
     LATERAL (SELECT g.day::date AS d) x;

INSERT INTO star.dim_time
SELECT s, s / 4, (s % 4) * 15, lpad((s / 4)::text, 2, '0') || ':' || lpad(((s % 4) * 15)::text, 2, '0')
FROM generate_series(0, 95) AS s;

INSERT INTO star.dim_company
SELECT row_number() OVER (ORDER BY canonical_name COLLATE "C"), company_id, name
FROM oltp.companies;

INSERT INTO star.dim_payment
SELECT row_number() OVER (ORDER BY name COLLATE "C"), payment_type_id, name
FROM oltp.payment_types;

-- area_key = community_area_id (1..77); 0 is the Unknown member.
INSERT INTO star.dim_area VALUES (0, NULL, 'Unknown');
INSERT INTO star.dim_area
SELECT community_area_id, community_area_id, name FROM oltp.community_areas;

INSERT INTO star.dim_taxi VALUES (0, NULL);
INSERT INTO star.dim_taxi
SELECT row_number() OVER (ORDER BY taxi_hash COLLATE "C"), taxi_hash FROM oltp.taxis;

INSERT INTO star.fact_trips
SELECT t.trip_id,
       (extract(year FROM t.trip_start_timestamp) * 10000
        + extract(month FROM t.trip_start_timestamp) * 100
        + extract(day FROM t.trip_start_timestamp))::integer,
       (extract(hour FROM t.trip_start_timestamp) * 4
        + extract(minute FROM t.trip_start_timestamp)::integer / 15)::smallint,
       coalesce(pa.area_key, 0),
       coalesce(da.area_key, 0),
       dc.company_key,
       dp.payment_key,
       coalesce(dt.taxi_key, 0),
       t.trip_seconds, t.trip_miles, t.fare, t.tips, t.tolls, t.extras, t.trip_total
FROM oltp.trips t
JOIN star.dim_company dc     ON dc.company_id = t.company_id
JOIN star.dim_payment dp     ON dp.payment_type_id = t.payment_type_id
LEFT JOIN star.dim_area pa   ON pa.community_area_id = t.pickup_community_area_id
LEFT JOIN star.dim_area da   ON da.community_area_id = t.dropoff_community_area_id
LEFT JOIN oltp.taxis ot      ON ot.taxi_id = t.taxi_id
LEFT JOIN star.dim_taxi dt   ON dt.taxi_hash = ot.taxi_hash
ORDER BY t.trip_start_timestamp, t.trip_id COLLATE "C";
