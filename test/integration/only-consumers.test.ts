import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import ts from "typescript";
import { unbarrelify } from "../../src/main.ts";
import type { Options } from "../../src/types.ts";
import { copyFixture } from "../helpers.ts";

function run(dir: string, entry: string): { status: number | null; stdout: string } {
  const result = spawnSync(process.execPath, [join(dir, entry)], { cwd: dir, encoding: "utf-8", timeout: 20_000 });
  return { status: result.status, stdout: result.stdout };
}

for (const only of [[], ["inner.mjs", "outer.mjs"], ["outer.mjs", "inner.mjs"]]) {
  test(`a forced barrel retains its dynamic dependency with selection ${JSON.stringify(only)}`, async (t) => {
    const dir = await copyFixture(t, "only-consumers-forced-dynamic");
    assert.deepEqual(run(dir, "consumer.mjs"), { status: 0, stdout: "42\n" });
    const result = await unbarrelify(options(dir, { only, barrel: ["outer.mjs"] }));
    assert.deepEqual(result.deleted, []);
    for (const [barrel, consumer] of [
      ["inner.mjs", "outer.mjs"],
      ["outer.mjs", "consumer.mjs"],
    ]) {
      assert.deepEqual(
        result.preserved.find(({ path }) => path === join(dir, barrel)),
        {
          path: join(dir, barrel),
          reason: "dynamic-import",
          consumers: [join(dir, consumer)],
        },
      );
    }
    assert.deepEqual(run(dir, "consumer.mjs"), { status: 0, stdout: "42\n" });
  });
}

for (const only of [[], ["inner.mjs", "outer.mjs"], ["outer.mjs", "inner.mjs"]]) {
  test(`a forced barrel star re-export is reported with selection ${JSON.stringify(only)}`, async (t) => {
    const dir = await copyFixture(t, "only-consumers-forced-star");
    assert.deepEqual(run(dir, "consumer.mjs"), { status: 0, stdout: "42\n" });
    const result = await unbarrelify(options(dir, { only, barrel: ["outer.mjs"] }));
    assert.deepEqual(result.deleted, []);
    assert.deepEqual(
      result.preserved.find(({ path }) => path === join(dir, "inner.mjs")),
      { path: join(dir, "inner.mjs"), reason: "star-reexport", consumers: [join(dir, "outer.mjs")] },
    );
    assert.deepEqual(run(dir, "consumer.mjs"), { status: 0, stdout: "42\n" });
  });
}

for (const multipleSources of [true, false]) {
  test(`an explicit barrel has a TypeScript namespace consumer with ${multipleSources ? "multiple sources" : "one source"}`, async (t) => {
    const original = 'import * as ns from "./barrel.mjs";\nconsole.log(ns.a + ns.b);\n';
    const dir = await copyFixture(
      t,
      multipleSources ? "only-consumers-ts-namespace-multi" : "only-consumers-ts-namespace-single",
    );
    const execute = async () => {
      const source = await readFile(join(dir, "consumer.ts"), "utf-8");
      const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } });
      const result = spawnSync(process.execPath, ["--input-type=module", "--eval", outputText], {
        cwd: dir,
        encoding: "utf-8",
        timeout: 20_000,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, "42\n");
    };
    await execute();
    const result = await unbarrelify(options(dir, { only: ["barrel.mjs"], files: ["**/*.ts", "**/*.mjs"] }));
    if (multipleSources) {
      assert.deepEqual(result.deleted, []);
      assert.deepEqual(result.preserved, [
        {
          path: join(dir, "barrel.mjs"),
          reason: "namespace-import",
          consumers: [join(dir, "consumer.ts")],
        },
      ]);
      assert.equal(await readFile(join(dir, "consumer.ts"), "utf-8"), original);
    } else {
      assert.deepEqual(result.deleted, [join(dir, "barrel.mjs")]);
      assert.deepEqual(result.preserved, []);
      assert.match(await readFile(join(dir, "consumer.ts"), "utf-8"), /\.\/a\.mjs/);
    }
    await execute();
  });
}

function options(dir: string, extra: Partial<Options>): Options {
  return { cwd: dir, files: ["**/*.mjs"], ext: ".mjs", write: true, ...extra };
}

describe("--only keeps consumer safety discovery", () => {
  test("ordinary mode preserves a dynamically imported barrel (control)", async (t) => {
    const dir = await copyFixture(t, "only-consumers-dynamic");
    assert.deepEqual(run(dir, "consumer.mjs"), { status: 0, stdout: "42\n" });

    const result = await unbarrelify(options(dir, {}));

    assert.deepEqual(result.deleted, []);
    assert.deepEqual(result.preserved, [
      { path: join(dir, "barrel.mjs"), reason: "dynamic-import", consumers: [join(dir, "consumer.mjs")] },
    ]);
    assert.deepEqual(run(dir, "consumer.mjs"), { status: 0, stdout: "42\n" });
  });

  test("preserves an explicit barrel that is dynamically imported", async (t) => {
    const dir = await copyFixture(t, "only-consumers-dynamic");
    assert.deepEqual(run(dir, "consumer.mjs"), { status: 0, stdout: "42\n" });

    const result = await unbarrelify(options(dir, { only: ["barrel.mjs"] }));

    assert.deepEqual(result.deleted, []);
    assert.deepEqual(result.preserved, [
      { path: join(dir, "barrel.mjs"), reason: "dynamic-import", consumers: [join(dir, "consumer.mjs")] },
    ]);
    assert.ok(existsSync(join(dir, "barrel.mjs")));
    assert.deepEqual(run(dir, "consumer.mjs"), { status: 0, stdout: "42\n" });
  });

  test("dry-run and check report the explicit dynamic barrel as preserved", async (t) => {
    for (const extra of [{ write: false }, { write: true, check: true }] satisfies Partial<Options>[]) {
      const dir = await copyFixture(t, "only-consumers-dynamic");
      const result = await unbarrelify(options(dir, { only: ["barrel.mjs"], ...extra }));

      assert.deepEqual(result.deleted, []);
      assert.deepEqual(result.preserved, [
        { path: join(dir, "barrel.mjs"), reason: "dynamic-import", consumers: [join(dir, "consumer.mjs")] },
      ]);
      assert.ok(existsSync(join(dir, "barrel.mjs")));
    }
  });

  test("still rewrites static consumers and deletes the explicit barrel", async (t) => {
    const dir = await copyFixture(t, "only-consumers-static");
    assert.deepEqual(run(dir, "consumer.mjs"), { status: 0, stdout: "42\n" });

    const result = await unbarrelify(options(dir, { only: ["barrel.mjs"] }));

    assert.deepEqual(result.modified, [join(dir, "consumer.mjs")]);
    assert.deepEqual(result.deleted, [join(dir, "barrel.mjs")]);
    assert.deepEqual(result.preserved, []);
    assert.ok(!existsSync(join(dir, "barrel.mjs")));
    assert.deepEqual(run(dir, "consumer.mjs"), { status: 0, stdout: "42\n" });
  });

  test("only restricts target barrels: nonmatched barrels are not tracked", async (t) => {
    const dir = await copyFixture(t, "only-consumers-unselected");
    assert.deepEqual(run(dir, "consumer.mjs"), { status: 0, stdout: "42 7\n" });

    const result = await unbarrelify(options(dir, { only: ["barrel.mjs"] }));

    assert.deepEqual(result.modified, []);
    assert.deepEqual(result.deleted, []);
    assert.deepEqual(result.preserved, [
      { path: join(dir, "barrel.mjs"), reason: "dynamic-import", consumers: [join(dir, "consumer.mjs")] },
    ]);
    assert.ok(existsSync(join(dir, "unselected.mjs")));
    assert.deepEqual(run(dir, "consumer.mjs"), { status: 0, stdout: "42 7\n" });
  });

  test("preserves an explicit barrel that a selected barrel still re-exports", async (t) => {
    const dir = await copyFixture(t, "only-consumers-selected-reexport");
    assert.deepEqual(run(dir, "consumer.mjs"), { status: 0, stdout: "42\n" });

    const result = await unbarrelify(options(dir, { only: ["inner.mjs", "outer.mjs"] }));

    assert.deepEqual(result.deleted, []);
    assert.ok(existsSync(join(dir, "inner.mjs")));
    assert.ok(existsSync(join(dir, "outer.mjs")));
    assert.deepEqual(run(dir, "consumer.mjs"), { status: 0, stdout: "42\n" });
  });

  test("handles a namespace consumer of an explicit barrel like ordinary mode", async (t) => {
    const ordinaryDir = await copyFixture(t, "only-consumers-namespace");
    const ordinary = await unbarrelify(options(ordinaryDir, {}));
    const dir = await copyFixture(t, "only-consumers-namespace");
    assert.deepEqual(run(dir, "consumer.mjs"), { status: 0, stdout: "42\n" });

    const result = await unbarrelify(options(dir, { only: ["barrel.mjs"] }));

    const relative = (paths: string[], base: string) => paths.map((p) => p.slice(base.length));
    assert.deepEqual(result.preserved, [
      { path: join(dir, "barrel.mjs"), reason: "namespace-import", consumers: [join(dir, "consumer.mjs")] },
    ]);
    assert.deepEqual(relative(result.deleted, dir), relative(ordinary.deleted, ordinaryDir));
    assert.deepEqual(
      result.preserved.map(({ path, reason, consumers }) => [path.slice(dir.length), reason, relative(consumers, dir)]),
      ordinary.preserved.map(({ path, reason, consumers }) => [
        path.slice(ordinaryDir.length),
        reason,
        relative(consumers, ordinaryDir),
      ]),
    );
    assert.deepEqual(run(dir, "consumer.mjs"), { status: 0, stdout: "42\n" });
    assert.deepEqual(run(ordinaryDir, "consumer.mjs"), { status: 0, stdout: "42\n" });
  });

  test("preserves an explicit barrel imported by a non-TypeScript consumer", async (t) => {
    const dir = await copyFixture(t, "only-consumers-vue");

    const result = await unbarrelify(options(dir, { only: ["barrel.mjs"] }));

    assert.deepEqual(result.deleted, []);
    assert.deepEqual(result.preserved, [
      { path: join(dir, "barrel.mjs"), reason: "non-ts-import", consumers: [join(dir, "page.vue")] },
    ]);
    assert.ok(existsSync(join(dir, "barrel.mjs")));
  });
});
