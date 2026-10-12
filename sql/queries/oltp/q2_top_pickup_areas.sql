-- Q2: top 10 pickup community areas by revenue, with average ticket, excluding unknown areas.
SELECT ca.community_area_id,
       ca.name               AS area_name,
       count(*)              AS trips,
       sum(t.trip_total)     AS revenue,
       avg(t.trip_total)     AS avg_ticket
FROM trips t
JOIN community_areas ca ON ca.community_area_id = t.pickup_community_area_id
WHERE t.pickup_community_area_id IS NOT NULL      -- exclude unknown areas
GROUP BY ca.community_area_id, ca.name
ORDER BY revenue DESC, ca.community_area_id
LIMIT 10;
