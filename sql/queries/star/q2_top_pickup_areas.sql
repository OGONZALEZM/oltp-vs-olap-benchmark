-- Q2: top 10 pickup community areas by revenue, with average ticket, excluding unknown areas.
SELECT a.community_area_id,
       a.area_name,
       count(*)          AS trips,
       sum(f.trip_total) AS revenue,
       avg(f.trip_total) AS avg_ticket
FROM fact_trips f
JOIN dim_area a ON a.area_key = f.pickup_area_key
WHERE f.pickup_area_key <> 0                      -- exclude unknown areas
GROUP BY a.community_area_id, a.area_name
ORDER BY revenue DESC, a.community_area_id
LIMIT 10;
