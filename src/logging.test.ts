import { describe, expect, it } from "vitest";
import { sanitize, setRedactionSecrets } from "./logging.js";

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
});
