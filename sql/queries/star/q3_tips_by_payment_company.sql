-- Q3: average tip by payment type and company, for one quarter.
SELECT p.payment_type,
       c.company_name AS company,
       count(*)       AS trips,
       avg(f.tips)    AS avg_tip
FROM fact_trips f
JOIN dim_date d    ON d.date_key = f.date_key
JOIN dim_payment p ON p.payment_key = f.payment_key
JOIN dim_company c ON c.company_key = f.company_key
WHERE d.year = {{quarter_year}} AND d.quarter = {{quarter}}
GROUP BY p.payment_type, c.company_name
ORDER BY 1, 2;
