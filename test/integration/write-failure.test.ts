import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs, { chmod, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { unbarrelify } from "../../src/index.ts";
import { copyFixture } from "../helpers.ts";

async function createProject(t: TestContext, consumers: string[]) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "unbarrelify-write-failure-")));
  t.after(() => rm(dir, { recursive: true }));
  const barrel = join(dir, "barrel.ts");
  const original = 'import { value } from "./barrel.ts";\nconsole.log(value);\n';
  await writeFile(join(dir, "value.ts"), "export const value = 42;\n");
  await writeFile(barrel, 'export { value } from "./value.ts";\n');
  for (const name of consumers) await writeFile(join(dir, name), original);
  return { dir, barrel, original };
}

for (const consumers of [["failed.ts"], ["written.ts", "failed.ts"]]) {
  test(`keeps a barrel when writing one of ${consumers.length} consumers fails`, async (t) => {
    const { dir, barrel, original } = await createProject(t, consumers);
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
    const { dir, barrel } = await createProject(t, ["written.ts", name]);
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

for (const options of [{ write: true }, { write: false }, { write: true, check: true }]) {
  test(`retains successful rewrite behavior for ${JSON.stringify(options)}`, async (t) => {
    const { dir, barrel, original } = await createProject(t, ["consumer.ts"]);
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
