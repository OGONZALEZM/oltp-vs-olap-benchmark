-- Q4: day-of-week x hour matrix: trip volume and average duration (trip_seconds).
SELECT d.iso_dow, t.hour,
       count(*)            AS trips,
       avg(f.trip_seconds) AS avg_seconds
FROM fact_trips f
JOIN dim_date d ON d.date_key = f.date_key
JOIN dim_time t ON t.time_key = f.time_key
GROUP BY d.iso_dow, t.hour
ORDER BY d.iso_dow, t.hour;
