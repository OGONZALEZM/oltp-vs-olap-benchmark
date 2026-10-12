-- Q3: average tip by payment type and company, for one quarter.
SELECT p.name      AS payment_type,
       c.name      AS company,
       count(*)    AS trips,
       avg(t.tips) AS avg_tip
FROM trips t
JOIN payment_types p ON p.payment_type_id = t.payment_type_id
JOIN companies c     ON c.company_id = t.company_id
WHERE t.trip_start_timestamp >= {{quarter_start}}
  AND t.trip_start_timestamp <  {{quarter_end}}
GROUP BY p.name, c.name
ORDER BY 1, 2;
