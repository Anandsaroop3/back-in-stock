-- Supports the admin "activity" chart and recency queries without scanning every request.
CREATE INDEX requests_notified_at ON requests (notified_at) WHERE notified_at IS NOT NULL;
