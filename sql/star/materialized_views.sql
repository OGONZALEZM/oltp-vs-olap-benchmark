-- B-MV: pre-aggregations over the star schema, one per benchmark question. Each stores
-- additive measures (sums and counts) at the question's grain, and the query derives averages
-- at read time. Build time is measured and reported; MV queries are a separate benchmark row
-- and are never presented as the same work as querying the fact table.
DROP MATERIALIZED VIEW IF EXISTS star.mv_monthly, star.mv_pickup_area,
    star.mv_quarter_payment_company, star.mv_dow_hour;

CREATE MATERIALIZED VIEW star.mv_monthly AS
SELECT d.year, d.month, count(*) AS trips, sum(f.trip_total) AS revenue, sum(f.fare) AS sum_fare
FROM star.fact_trips f JOIN star.dim_date d ON d.date_key = f.date_key
GROUP BY d.year, d.month;

CREATE MATERIALIZED VIEW star.mv_pickup_area AS
SELECT f.pickup_area_key, a.community_area_id, a.area_name,
       count(*) AS trips, sum(f.trip_total) AS revenue
FROM star.fact_trips f JOIN star.dim_area a ON a.area_key = f.pickup_area_key
GROUP BY f.pickup_area_key, a.community_area_id, a.area_name;

CREATE MATERIALIZED VIEW star.mv_quarter_payment_company AS
SELECT d.year, d.quarter, p.payment_type, c.company_name AS company,
       count(*) AS trips, sum(f.tips) AS sum_tips
FROM star.fact_trips f
JOIN star.dim_date d    ON d.date_key = f.date_key
JOIN star.dim_payment p ON p.payment_key = f.payment_key
JOIN star.dim_company c ON c.company_key = f.company_key
GROUP BY d.year, d.quarter, p.payment_type, c.company_name;

-- trip_seconds is nullable: n_seconds counts non-null values so the average matches avg().
CREATE MATERIALIZED VIEW star.mv_dow_hour AS
SELECT d.iso_dow, t.hour, count(*) AS trips,
       sum(f.trip_seconds)::numeric AS sum_seconds, count(f.trip_seconds) AS n_seconds
FROM star.fact_trips f
JOIN star.dim_date d ON d.date_key = f.date_key
JOIN star.dim_time t ON t.time_key = f.time_key
GROUP BY d.iso_dow, t.hour;
