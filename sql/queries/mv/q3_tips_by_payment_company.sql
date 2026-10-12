-- Q3 from the pre-aggregated materialized view (B-MV), for one quarter.
SELECT payment_type, company, trips, sum_tips / trips AS avg_tip
FROM mv_quarter_payment_company
WHERE year = {{quarter_year}} AND quarter = {{quarter}}
ORDER BY 1, 2;
