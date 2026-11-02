db = db.getSiblingDB("tenant_a");
db.users.insertMany([
  { name: "Alice", email: "alice@tenant-a.com", active: true },
  { name: "Bob", email: "bob@tenant-a.com", active: false },
]);
db.settings.insertOne({ key: "theme", value: "dark" });

db = db.getSiblingDB("tenant_b");
db.orders.insertMany([
  { orderId: "ORD-001", amount: 150.0, status: "completed" },
  { orderId: "ORD-002", amount: 89.95, status: "pending" },
]);

db = db.getSiblingDB("analytics_staging");
db.events.insertMany([
  { event: "page_view", path: "/home", timestamp: 1700000000 },
  { event: "click", target: "buy-now", timestamp: 1700000001 },
]);
