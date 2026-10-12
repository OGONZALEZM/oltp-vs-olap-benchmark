-- Config B: foreign keys and indexes, applied after the bulk load.
-- Index parity with config A: one btree per fact foreign key, mirroring A's FK indexes.
-- date_key plays the role of A's trip_start_timestamp index. time_key has no counterpart in A
-- (A's timestamp index covers both date and time), so it is not indexed.
ALTER TABLE star.fact_trips
    ADD CONSTRAINT fact_date_fk         FOREIGN KEY (date_key)         REFERENCES star.dim_date,
    ADD CONSTRAINT fact_time_fk         FOREIGN KEY (time_key)         REFERENCES star.dim_time,
    ADD CONSTRAINT fact_pickup_area_fk  FOREIGN KEY (pickup_area_key)  REFERENCES star.dim_area,
    ADD CONSTRAINT fact_dropoff_area_fk FOREIGN KEY (dropoff_area_key) REFERENCES star.dim_area,
    ADD CONSTRAINT fact_company_fk      FOREIGN KEY (company_key)      REFERENCES star.dim_company,
    ADD CONSTRAINT fact_payment_fk      FOREIGN KEY (payment_key)      REFERENCES star.dim_payment,
    ADD CONSTRAINT fact_taxi_fk         FOREIGN KEY (taxi_key)         REFERENCES star.dim_taxi;

CREATE INDEX fact_date_idx         ON star.fact_trips (date_key);
CREATE INDEX fact_pickup_area_idx  ON star.fact_trips (pickup_area_key);
CREATE INDEX fact_dropoff_area_idx ON star.fact_trips (dropoff_area_key);
CREATE INDEX fact_company_idx      ON star.fact_trips (company_key);
CREATE INDEX fact_payment_idx      ON star.fact_trips (payment_key);
CREATE INDEX fact_taxi_idx         ON star.fact_trips (taxi_key);
