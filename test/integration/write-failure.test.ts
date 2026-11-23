import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs, { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unbarrelify } from "../../src/index.ts";

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
      assert.ok(result.preserved.some((entry) => entry.path === barrel && entry.consumers.includes(failed)));

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
