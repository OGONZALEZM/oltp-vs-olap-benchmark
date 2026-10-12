-- Q1: trips, total revenue (trip_total) and average fare per month. Runs unchanged on B and C.
SELECT d.year, d.month,
       count(*)          AS trips,
       sum(f.trip_total) AS revenue,
       avg(f.fare)       AS avg_fare
FROM fact_trips f
JOIN dim_date d ON d.date_key = f.date_key
GROUP BY d.year, d.month
ORDER BY d.year, d.month;
