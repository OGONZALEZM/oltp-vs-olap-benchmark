-- Q1 from the pre-aggregated materialized view (B-MV, reported separately from B).
SELECT year, month, trips, revenue, sum_fare / trips AS avg_fare
FROM mv_monthly
ORDER BY year, month;
