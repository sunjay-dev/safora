CREATE DATABASE tenant_a;
\connect tenant_a
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    email VARCHAR(100) NOT NULL,
    active BOOLEAN DEFAULT TRUE
);
INSERT INTO users (name, email, active) VALUES
    ('Alice', 'alice@tenant-a.com', TRUE),
    ('Bob', 'bob@tenant-a.com', FALSE);

CREATE TABLE settings (
    key VARCHAR(50) PRIMARY KEY,
    value VARCHAR(255) NOT NULL
);
INSERT INTO settings (key, value) VALUES ('theme', 'dark');

CREATE DATABASE tenant_b;
\connect tenant_b
CREATE TABLE orders (
    order_id VARCHAR(50) PRIMARY KEY,
    amount NUMERIC(10, 2) NOT NULL,
    status VARCHAR(50) NOT NULL
);
INSERT INTO orders (order_id, amount, status) VALUES
    ('ORD-001', 150.00, 'completed'),
    ('ORD-002', 89.95, 'pending');

CREATE DATABASE analytics_staging;
\connect analytics_staging
CREATE TABLE events (
    id SERIAL PRIMARY KEY,
    event VARCHAR(50) NOT NULL,
    path VARCHAR(255) NOT NULL,
    timestamp BIGINT NOT NULL
);
INSERT INTO events (event, path, timestamp) VALUES
    ('page_view', '/home', 1700000000),
    ('click', '/buy-now', 1700000001);
