-- Config A: foreign keys and indexes, applied after the bulk load.
-- "Reasonable" OLTP indexing: every FK column plus the start timestamp. Nothing tuned to the
-- benchmark queries (no covering or composite indexes): that would turn A into an OLAP model.
ALTER TABLE oltp.trips
    ADD CONSTRAINT trips_taxi_fk           FOREIGN KEY (taxi_id)                   REFERENCES oltp.taxis,
    ADD CONSTRAINT trips_company_fk        FOREIGN KEY (company_id)                REFERENCES oltp.companies,
    ADD CONSTRAINT trips_payment_type_fk   FOREIGN KEY (payment_type_id)           REFERENCES oltp.payment_types,
    ADD CONSTRAINT trips_pickup_area_fk    FOREIGN KEY (pickup_community_area_id)  REFERENCES oltp.community_areas,
    ADD CONSTRAINT trips_dropoff_area_fk   FOREIGN KEY (dropoff_community_area_id) REFERENCES oltp.community_areas;

CREATE INDEX trips_taxi_idx         ON oltp.trips (taxi_id);
CREATE INDEX trips_company_idx      ON oltp.trips (company_id);
CREATE INDEX trips_payment_type_idx ON oltp.trips (payment_type_id);
CREATE INDEX trips_pickup_area_idx  ON oltp.trips (pickup_community_area_id);
CREATE INDEX trips_dropoff_area_idx ON oltp.trips (dropoff_community_area_id);
CREATE INDEX trips_start_ts_idx     ON oltp.trips (trip_start_timestamp);
