CREATE TABLE employee_notification_attempts (
    scheduled_for TIMESTAMPTZ(3) NOT NULL,
    attempt INTEGER NOT NULL CHECK (attempt > 0),
    business_date DATE NOT NULL,
    timezone VARCHAR(100) NOT NULL,
    status VARCHAR(16) NOT NULL CHECK (status IN ('RUNNING','SUCCEEDED','FAILED','INTERRUPTED')),
    started_at TIMESTAMPTZ(3) NOT NULL,
    finished_at TIMESTAMPTZ(3),
    next_retry_at TIMESTAMPTZ(3),
    scanned_count INTEGER NOT NULL DEFAULT 0 CHECK (scanned_count >= 0),
    published_count INTEGER NOT NULL DEFAULT 0 CHECK (published_count >= 0),
    failure_code VARCHAR(32),
    PRIMARY KEY (scheduled_for, attempt)
);

GRANT SELECT, INSERT, UPDATE ON employee_notification_attempts TO employee_runtime;
