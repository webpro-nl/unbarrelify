import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs, { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { unbarrelify } from "../../src/index.ts";
import { snapshotDir } from "./helpers.ts";

const barrel = 'export * from "./a.mjs";\nexport * from "./b.mjs";\n';

async function createProject(t: TestContext): Promise<string> {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "unbarrelify-run-cache-")));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return cwd;
}

async function writeSources(cwd: string, moved: boolean): Promise<void> {
  await writeFile(join(cwd, "a.mjs"), moved ? "export const bar = 300;\n" : "export const foo = 100;\n");
  await writeFile(join(cwd, "b.mjs"), moved ? "export const foo = 400;\n" : "export const bar = 200;\n");
}

function runConsumer(cwd: string, name: string, expected: string): void {
  const result = spawnSync(process.execPath, [join(cwd, name)], { encoding: "utf8", timeout: 5000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), expected);
}

for (const explicit of [false, true]) {
  const mode = explicit ? "only" : "discovery";

  test(`public API refreshes exported names after a dry-run (${mode})`, { timeout: 15000 }, async (t) => {
    const cwd = await createProject(t);
    await writeSources(cwd, false);
    await writeFile(join(cwd, "barrel.mjs"), barrel);
    await writeFile(join(cwd, "consumer.mjs"), 'import { foo } from "./barrel.mjs";\nconsole.log(foo);\n');
    const options = { cwd, ext: ".mjs", only: explicit ? ["barrel.mjs"] : [] };
    const before = await snapshotDir(cwd);
    runConsumer(cwd, "consumer.mjs", "100");

    const dryRun = await unbarrelify({ ...options, write: false });
    assert.deepEqual(dryRun.modified, [join(cwd, "consumer.mjs")]);
    assert.deepEqual(dryRun.deleted, [join(cwd, "barrel.mjs")]);
    assert.deepEqual(await snapshotDir(cwd), before);

    await writeSources(cwd, true);
    runConsumer(cwd, "consumer.mjs", "400");
    const result = await unbarrelify({ ...options, write: true });

    assert.deepEqual(result.modified, [join(cwd, "consumer.mjs")]);
    assert.deepEqual(result.deleted, [join(cwd, "barrel.mjs")]);
    assert.deepEqual(result.untraceableImports, []);
    await assert.rejects(readFile(join(cwd, "barrel.mjs")), { code: "ENOENT" });
    runConsumer(cwd, "consumer.mjs", "400");
    assert.match(await readFile(join(cwd, "consumer.mjs"), "utf8"), /from ["']\.\/b\.mjs["']/);
  });

  test(`overlapping API runs keep independent reusable export snapshots (${mode})`, { timeout: 15000 }, async (t) => {
    const cwd = await createProject(t);
    await writeSources(cwd, false);
    for (const name of ["first.mjs", "second.mjs", "third.mjs", "other.mjs"]) {
      await writeFile(join(cwd, name), barrel);
    }
    await writeFile(
      join(cwd, "consumer.mjs"),
      'import { foo } from "./first.mjs";\nimport { bar } from "./second.mjs";\n' +
        'import { foo as again } from "./third.mjs";\nconsole.log(foo + bar + again);\n',
    );
    await writeFile(
      join(cwd, "other-consumer.mjs"),
      'import { foo, bar } from "./other.mjs";\nconsole.log(foo + bar);\n',
    );

    const paused = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const reads = new Map<string, number>();
    const originalReadFile = fs.readFile;
    const readMock = t.mock.method(fs, "readFile", async (...args: Parameters<typeof fs.readFile>) => {
      const path = String(args[0]);
      reads.set(path, (reads.get(path) ?? 0) + 1);
      const content = await originalReadFile(...args);
      if (path === join(cwd, "second.mjs")) {
        paused.resolve();
        await resume.promise;
      }
      return content;
    });
    syncBuiltinESMExports();

    const first = unbarrelify({
      cwd,
      ext: ".mjs",
      files: ["consumer.mjs"],
      only: explicit ? ["first.mjs", "second.mjs", "third.mjs"] : [],
      write: true,
    });
    try {
      await Promise.race([
        paused.promise,
        first.then(() => {
          throw new Error("First run finished before reaching the second barrel");
        }),
      ]);
      // The first run has read the original exports, but is still in progress.
      await writeSources(cwd, true);
      const second = await unbarrelify({
        cwd,
        ext: ".mjs",
        files: ["other-consumer.mjs"],
        only: explicit ? ["other.mjs"] : [],
        write: true,
      });
      assert.deepEqual(second.modified, [join(cwd, "other-consumer.mjs")]);
      assert.deepEqual(second.untraceableImports, []);
      runConsumer(cwd, "other-consumer.mjs", "700");

      // Restore the first run's sources before it resumes and executes its consumer.
      await writeSources(cwd, false);
      resume.resolve();
      const result = await first;
      assert.deepEqual(result.modified, [join(cwd, "consumer.mjs")]);
      assert.deepEqual(result.untraceableImports, []);
      runConsumer(cwd, "consumer.mjs", "400");
      for (const name of ["a.mjs", "b.mjs"]) {
        // At most one export scan and one full analysis per source per run,
        // regardless of the number of barrels re-exporting that source.
        assert.ok((reads.get(join(cwd, name)) ?? 0) <= 4, `${name} was reread for each barrel`);
      }
    } finally {
      resume.resolve();
      await Promise.allSettled([first]);
      readMock.mock.restore();
      syncBuiltinESMExports();
    }
  });
}
