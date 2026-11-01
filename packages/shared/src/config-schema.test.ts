import { describe, expect, it } from "vitest";
import { paperclipConfigSchema } from "./config-schema.js";

describe("paperclip config schema", () => {
  it("defaults omitted runtime paths to legacy instance-root locations", () => {
    const parsed = paperclipConfigSchema.parse({
      $meta: {
        version: 1,
        updatedAt: "2026-05-10T00:00:00.000Z",
        source: "configure",
      },
      database: {
        mode: "embedded-postgres",
      },
      logging: {
        mode: "file",
      },
      server: {},
    });

    expect(parsed.database.embeddedPostgresDataDir).toBe("~/.paperclip/instances/default/db");
    expect(parsed.database.backup.dir).toBe("~/.paperclip/instances/default/data/backups");
    expect(parsed.logging.logDir).toBe("~/.paperclip/instances/default/logs");
    expect(parsed.storage.localDisk.baseDir).toBe("~/.paperclip/instances/default/data/storage");
    expect(parsed.secrets.localEncrypted.keyFilePath).toBe("~/.paperclip/instances/default/secrets/master.key");
  });

  it("returns fresh default objects on every parse (zod 4 does not clone a .default(value) object)", () => {
    const minimal = {
      $meta: { version: 1, updatedAt: "2026-05-10T00:00:00.000Z", source: "configure" },
      database: { mode: "embedded-postgres" },
      logging: { mode: "file" },
      server: {},
    };
    const first = paperclipConfigSchema.parse(minimal);
    first.storage.s3.prefix = "mutated";
    first.storage.localDisk.baseDir = "/mutated";
    first.secrets.localEncrypted.keyFilePath = "/mutated";
    first.database.backup.dir = "/mutated";
    first.auth.disableSignUp = true;
    const second = paperclipConfigSchema.parse(minimal);
    expect(second.storage.s3.prefix).toBe("");
    expect(second.storage.localDisk.baseDir).toBe("~/.paperclip/instances/default/data/storage");
    expect(second.secrets.localEncrypted.keyFilePath).toBe("~/.paperclip/instances/default/secrets/master.key");
    expect(second.database.backup.dir).toBe("~/.paperclip/instances/default/data/backups");
    expect(second.auth.disableSignUp).toBe(false);
  });
});
