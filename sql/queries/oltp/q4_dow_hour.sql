-- Q4: day-of-week x hour matrix: trip volume and average duration (trip_seconds).
SELECT extract(isodow FROM trip_start_timestamp)::int AS iso_dow,
       extract(hour FROM trip_start_timestamp)::int   AS hour,
       count(*)                                       AS trips,
       avg(trip_seconds)                              AS avg_seconds
FROM trips
GROUP BY 1, 2
ORDER BY 1, 2;
