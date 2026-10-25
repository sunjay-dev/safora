import { describe, expect, it } from "vitest";
import { fail, sanitize, setRedactionSecrets } from "./logging.js";

describe("URI redaction", () => {
  it("redacts the MongoDB URI as before", () => {
    setRedactionSecrets([{ name: "MONGODB_URI", value: "mongodb://secret-host/cluster" }]);
    expect(sanitize("boom mongodb://secret-host/cluster")).toBe("boom ***MONGODB_URI***");
  });

  it("redacts the PostgreSQL URI", () => {
    const uri = "postgresql://backup-user:sup3r-s3cret@db.internal/app";
    setRedactionSecrets([{ name: "POSTGRESQL_URI", value: uri }]);
    expect(sanitize(`error while connecting to ${uri}`)).toBe("error while connecting to ***POSTGRESQL_URI***");
  });

  it("redacts both connection strings independently", () => {
    const mongoUri = "mongodb://secret-host/cluster";
    const postgresUri = "postgresql://backup-user:sup3r-s3cret@db.internal/app";
    setRedactionSecrets([
      { name: "MONGODB_URI", value: mongoUri },
      { name: "POSTGRESQL_URI", value: postgresUri },
    ]);
    const text = `mongo=${mongoUri} postgres=${postgresUri}`;
    expect(sanitize(text)).toBe("mongo=***MONGODB_URI*** postgres=***POSTGRESQL_URI***");
  });

  it("never redacts an empty secret", () => {
    setRedactionSecrets([{ name: "POSTGRESQL_URI", value: "" }]);
    expect(sanitize("nothing to redact")).toBe("nothing to redact");
  });

  it("redacts longer secrets before shorter substrings", () => {
    setRedactionSecrets([
      { name: "SHORT", value: "secret" },
      { name: "LONG", value: "secret-sauce" },
    ]);
    expect(sanitize("value=secret-sauce")).toBe("value=***LONG***");
  });

  it("redacts both the full URI and standalone password without leaking either", () => {
    const uri = "postgresql://backup-user:sup3r-s3cret@db.internal:5433/app?sslmode=require";
    const password = "sup3r-s3cret";
    setRedactionSecrets([
      { name: "POSTGRESQL_URI", value: uri },
      { name: "POSTGRESQL_PASSWORD", value: password },
    ]);

    // Unredacted URI in message
    const msgWithUri = `connection failed to ${uri}`;
    const sanitizedUri = sanitize(msgWithUri);
    expect(sanitizedUri).not.toContain(uri);
    expect(sanitizedUri).not.toContain(password);
    expect(sanitizedUri).toBe("connection failed to ***POSTGRESQL_URI***");

    // Standalone password in message
    const msgWithPassword = `authentication failed for password: ${password}`;
    const sanitizedPassword = sanitize(msgWithPassword);
    expect(sanitizedPassword).not.toContain(password);
    expect(sanitizedPassword).toBe("authentication failed for password: ***POSTGRESQL_PASSWORD***");

    // In error thrown by fail()
    expect(() => fail(`database error with ${password} at ${uri}`)).toThrowError(
      "database error with ***POSTGRESQL_PASSWORD*** at ***POSTGRESQL_URI***",
    );
  });
});
