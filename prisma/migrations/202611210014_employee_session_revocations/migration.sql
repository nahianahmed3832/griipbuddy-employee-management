CREATE TABLE employee_session_revocations (
    fingerprint CHAR(64) PRIMARY KEY CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
    expires_at TIMESTAMPTZ(3) NOT NULL
);

CREATE INDEX employee_session_revocations_expires_at_idx ON employee_session_revocations(expires_at);
CREATE INDEX employee_session_revocations_user_id_idx ON employee_session_revocations(user_id);
