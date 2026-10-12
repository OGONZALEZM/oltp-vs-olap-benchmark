-- Q4 from the pre-aggregated materialized view (B-MV).
SELECT iso_dow, hour, trips, sum_seconds / n_seconds AS avg_seconds
FROM mv_dow_hour
ORDER BY iso_dow, hour;
