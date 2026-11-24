import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs, { chmod, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { unbarrelify } from "../../src/index.ts";
import { copyFixture } from "../helpers.ts";

const original = 'import { value } from "./barrel.ts";\nconsole.log(value);\n';

async function copyProject(t: TestContext, name: string) {
  const dir = await copyFixture(t, name);
  return { dir, barrel: join(dir, "barrel.ts"), original };
}

const failureSets: [string, string[]][] = [
  ["write-failure-failed", ["failed.ts"]],
  ["write-failure-written-failed", ["written.ts", "failed.ts"]],
];

for (const [fixture, consumers] of failureSets) {
  test(`keeps a barrel when writing one of ${consumers.length} consumers fails`, async (t) => {
    const { dir, barrel, original } = await copyProject(t, fixture);
    const failed = join(dir, "failed.ts");
    const originalWrite = fs.writeFile;
    const writeError = Object.assign(new Error("simulated write failure"), { code: "EACCES" });
    let failedWrites = 0;
    const errors = t.mock.method(console, "error", () => {});
    const writer = t.mock.method(fs, "writeFile", async (...args: Parameters<typeof fs.writeFile>) => {
      if (args[0] === failed) {
        failedWrites++;
        throw writeError;
      }
      return originalWrite(...args);
    });
    syncBuiltinESMExports();

    try {
      const result = await unbarrelify({ cwd: dir, files: ["*.ts"], ext: ".ts", write: true });

      assert.equal(failedWrites, 1, "the failure must occur during the consumer write");
      assert.ok(errors.mock.calls.some((call) => call.arguments.includes(writeError.message)));
      assert.equal(await readFile(failed, "utf-8"), original);
      assert.ok(existsSync(barrel), "the unchanged consumer still needs its barrel");
      assert.ok(!result.deleted.includes(barrel));
      assert.ok(!result.modified.includes(failed));
      assert.deepEqual(result.preserved, [{ path: barrel, reason: "consumer-error", consumers: [failed] }]);
      assert.deepEqual(
        result.errors.map(({ file }) => file),
        [failed],
      );

      if (consumers.includes("written.ts")) {
        const written = join(dir, "written.ts");
        assert.ok(result.modified.includes(written));
        assert.ok((await readFile(written, "utf-8")).includes('from "./value.ts"'));
      }
    } finally {
      writer.mock.restore();
      syncBuiltinESMExports();
    }
  });
}

for (const name of ["unreadable.ts", "unreadable.vue"]) {
  test(`stops without deleting barrels when reading ${name} fails`, async (t) => {
    const { dir, barrel } = await copyProject(t, `write-failure-${name.replace(".", "-")}`);
    const unreadable = join(dir, name);
    const originalRead = fs.readFile;
    const readError = Object.assign(new Error("simulated read failure"), { code: "EACCES" });
    t.mock.method(console, "error", () => {});
    const reader = t.mock.method(fs, "readFile", async (...args: Parameters<typeof fs.readFile>) => {
      if (args[0] === unreadable) throw readError;
      return originalRead(...args);
    });
    syncBuiltinESMExports();

    try {
      await assert.rejects(unbarrelify({ cwd: dir, files: ["*.ts"], ext: ".ts", write: true }), readError);
      assert.ok(existsSync(barrel), "the unreadable consumer may still import the barrel");
    } finally {
      reader.mock.restore();
      syncBuiltinESMExports();
    }
  });
}

test("stops without deleting barrels when reading a re-export target fails", async (t) => {
  const fixtureDir = await copyFixture(t, "nested-reexport-read");
  const unreadable = join(fixtureDir, "shared/x.ts");
  const originalRead = fs.readFile;
  const readError = Object.assign(new Error("simulated read failure"), { code: "EACCES" });
  t.mock.method(console, "error", () => {});
  const reader = t.mock.method(fs, "readFile", async (...args: Parameters<typeof fs.readFile>) => {
    if (args[0] === unreadable) throw readError;
    return originalRead(...args);
  });
  syncBuiltinESMExports();

  try {
    const options = { cwd: join(fixtureDir, "app"), files: ["**/*.ts"], only: ["a.ts", "b.ts"], write: true };
    await assert.rejects(unbarrelify(options), readError);
    assert.ok(existsSync(join(fixtureDir, "app/b.ts")), "the unreadable re-export still imports this barrel");
  } finally {
    reader.mock.restore();
    syncBuiltinESMExports();
  }
});

for (const only of [[], ["index.ts", "sub/index.ts"], ["sub/index.ts", "index.ts"]]) {
  test(`keeps a barrel whose consumer barrel could not be deleted (only: ${JSON.stringify(only)})`, async (t) => {
    const fixtureDir = await copyFixture(t, "chained-barrels");
    const failing = join(fixtureDir, "index.ts");
    const inner = join(fixtureDir, "sub/index.ts");
    const originalUnlink = fs.unlink;
    const unlinkError = Object.assign(new Error("simulated unlink failure"), { code: "EPERM" });
    t.mock.method(console, "error", () => {});
    t.mock.method(console, "log", () => {});
    const unlinker = t.mock.method(fs, "unlink", async (...args: Parameters<typeof fs.unlink>) => {
      if (args[0] === failing) throw unlinkError;
      return originalUnlink(...args);
    });
    syncBuiltinESMExports();

    try {
      const result = await unbarrelify({ cwd: fixtureDir, files: ["**/*.ts"], only, write: true });

      assert.deepEqual(result.deleted, []);
      assert.ok(existsSync(inner), "the barrel that could not be deleted still re-exports this one");
      assert.deepEqual(
        result.errors.map(({ file }) => file),
        [failing],
      );
      assert.deepEqual(result.preserved, [{ path: inner, reason: "consumer-error", consumers: [failing] }]);
    } finally {
      unlinker.mock.restore();
      syncBuiltinESMExports();
    }
  });
}

test("deletes a barrel that a rewritten consumer barrel no longer needs when deleting that consumer fails", async (t) => {
  const fixtureDir = await copyFixture(t, "forced-outer-barrel");
  const failing = join(fixtureDir, "locked/outer.ts");
  const originalUnlink = fs.unlink;
  const unlinkError = Object.assign(new Error("simulated unlink failure"), { code: "EPERM" });
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "log", () => {});
  const unlinker = t.mock.method(fs, "unlink", async (...args: Parameters<typeof fs.unlink>) => {
    if (args[0] === failing) throw unlinkError;
    return originalUnlink(...args);
  });
  syncBuiltinESMExports();

  try {
    const options = { cwd: fixtureDir, files: ["**/*.ts"], barrel: ["locked/outer.ts"], write: true };
    const result = await unbarrelify(options);

    assert.deepEqual(result.deleted, [join(fixtureDir, "lib/inner.ts")]);
    assert.deepEqual(
      result.errors.map(({ file }) => file),
      [failing],
    );
    assert.deepEqual(result.preserved, []);
    assert.ok(!(await readFile(failing, "utf-8")).includes("inner.ts"));
  } finally {
    unlinker.mock.restore();
    syncBuiltinESMExports();
  }
});

test("does not report a barrel as deleted when deleting it fails", async (t) => {
  const fixtureDir = await copyFixture(t, "chained-barrels");
  const failing = join(fixtureDir, "sub/index.ts");
  const originalUnlink = fs.unlink;
  const unlinkError = Object.assign(new Error("simulated unlink failure"), { code: "EPERM" });
  const errors = t.mock.method(console, "error", () => {});
  const logs = t.mock.method(console, "log", () => {});
  const unlinker = t.mock.method(fs, "unlink", async (...args: Parameters<typeof fs.unlink>) => {
    if (args[0] === failing) throw unlinkError;
    return originalUnlink(...args);
  });
  syncBuiltinESMExports();

  try {
    const result = await unbarrelify({ cwd: fixtureDir, files: ["**/*.ts"], write: true });

    assert.deepEqual(result.deleted, [join(fixtureDir, "index.ts")]);
    assert.deepEqual(
      result.errors.map(({ file }) => file),
      [failing],
    );
    assert.ok(existsSync(failing));
    assert.ok(errors.mock.calls.some((call) => call.arguments.includes(unlinkError.message)));
    const deletedLines = logs.mock.calls.flatMap((call) => String(call.arguments[0]).split("\n"));
    assert.ok(!deletedLines.some((line) => line.includes("deleted:") && line.includes("sub/index.ts")));
  } finally {
    unlinker.mock.restore();
    syncBuiltinESMExports();
  }
});

const cliPath = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
const skipPermissions = process.platform === "win32" || process.getuid?.() === 0;

for (const [action, target, mode] of [
  ["deleting a barrel", "sub", 0o555],
  ["writing a consumer", "consumer.ts", 0o444],
] as const) {
  test(`CLI exits 1 when ${action} fails`, { skip: skipPermissions }, async (t) => {
    const fixtureDir = await copyFixture(t, "chained-barrels");
    const path = join(fixtureDir, target);
    const { mode: originalMode } = await stat(path);
    await chmod(path, mode);

    try {
      const cli = spawnSync(process.execPath, [cliPath, "--write"], { cwd: fixtureDir, encoding: "utf-8" });

      assert.equal(cli.status, 1, cli.stderr);
      assert.match(cli.stderr, /Encountered 1 error\(s\) during processing/);
    } finally {
      await chmod(path, originalMode);
    }
  });
}

for (const files of [undefined, ["**/*.ts"]]) {
  test(
    `stops without changes when a directory cannot be read (files: ${JSON.stringify(files)})`,
    { skip: skipPermissions },
    async (t) => {
      const fixtureDir = await copyFixture(t, "unreadable-directory");
      const locked = join(fixtureDir, "locked");
      const visible = join(fixtureDir, "visible.ts");
      const original = await readFile(visible, "utf-8");
      await chmod(locked, 0o000);

      try {
        await assert.rejects(unbarrelify({ cwd: fixtureDir, files, write: true }), (error: NodeJS.ErrnoException) => {
          assert.equal(error.code, "EACCES");
          assert.match(error.path ?? "", /locked/);
          return true;
        });
      } finally {
        await chmod(locked, 0o755);
      }
      assert.ok(existsSync(join(fixtureDir, "barrel.ts")), "the hidden consumer still imports the barrel");
      assert.equal(await readFile(visible, "utf-8"), original);
    },
  );
}

test(
  "stops without deleting barrels when a package.json with package imports cannot be read",
  { skip: skipPermissions },
  async (t) => {
    const fixtureDir = await copyFixture(t, "unreadable-imports-manifest");
    const manifest = join(fixtureDir, "ui/package.json");
    await chmod(manifest, 0o000);

    try {
      const options = { cwd: fixtureDir, only: ["ui/live.mjs"], write: true };
      await assert.rejects(unbarrelify(options), (error: NodeJS.ErrnoException) => {
        assert.equal(error.code, "EACCES");
        assert.equal(error.path, manifest);
        return true;
      });
    } finally {
      await chmod(manifest, 0o644);
    }
    assert.ok(existsSync(join(fixtureDir, "ui/live.mjs")), "the Vue component still imports this barrel");
  },
);

for (const pattern of ["missing/**/*.ts", "index.ts/**/*.ts"]) {
  test(`finds no files for a literal prefix that is not a directory (${pattern})`, async (t) => {
    const fixtureDir = await copyFixture(t, "simple-barrel");

    const result = await unbarrelify({ cwd: fixtureDir, files: [pattern], write: true });

    assert.deepEqual(result.modified, []);
    assert.deepEqual(result.deleted, []);
    assert.deepEqual(result.errors, []);
  });
}

for (const options of [{ write: true }, { write: false }, { write: true, check: true }]) {
  test(`retains successful rewrite behavior for ${JSON.stringify(options)}`, async (t) => {
    const { dir, barrel, original } = await copyProject(t, "write-failure-consumer");
    const consumer = join(dir, "consumer.ts");
    const result = await unbarrelify({ cwd: dir, files: ["*.ts"], ext: ".ts", ...options });

    assert.deepEqual(result.modified, [consumer]);
    assert.deepEqual(result.deleted, [barrel]);
    const writes = options.write && !options.check;
    assert.equal(existsSync(barrel), !writes);
    const content = await readFile(consumer, "utf-8");
    if (writes) assert.ok(content.includes('from "./value.ts"'));
    else assert.equal(content, original);
  });
}
