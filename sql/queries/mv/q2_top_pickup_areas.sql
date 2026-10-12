-- Q2 from the pre-aggregated materialized view (B-MV), excluding unknown areas.
SELECT community_area_id, area_name, trips, revenue, revenue / trips AS avg_ticket
FROM mv_pickup_area
WHERE pickup_area_key <> 0                        -- exclude unknown areas
ORDER BY revenue DESC, community_area_id
LIMIT 10;
