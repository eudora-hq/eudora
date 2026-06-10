ALTER TABLE compliance_reports ADD COLUMN timestamp_token TEXT;
ALTER TABLE compliance_reports ADD COLUMN timestamp_status TEXT DEFAULT 'pending';
ALTER TABLE compliance_reports ADD COLUMN timestamp_time TEXT;
ALTER TABLE compliance_reports ADD COLUMN tsa_url TEXT DEFAULT 'https://freetsa.org/tsr';
