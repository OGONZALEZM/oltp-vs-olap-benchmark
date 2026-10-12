-- Q1: trips, total revenue (trip_total) and average fare per month.
SELECT extract(year FROM trip_start_timestamp)::int  AS year,
       extract(month FROM trip_start_timestamp)::int AS month,
       count(*)                                      AS trips,
       sum(trip_total)                               AS revenue,
       avg(fare)                                     AS avg_fare
FROM trips
GROUP BY 1, 2
ORDER BY 1, 2;
