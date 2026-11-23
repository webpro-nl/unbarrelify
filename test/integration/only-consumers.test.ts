import { test, describe } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { existsSync, realpathSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import ts from "typescript";
import { unbarrelify } from "../../src/main.ts";
import type { Options } from "../../src/types.ts";

async function project(t: TestContext, files: Record<string, string>): Promise<string> {
  const dir = realpathSync(await mkdtemp(join(tmpdir(), "only-consumers-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content, "utf-8");
  }
  return dir;
}

function run(dir: string, entry: string): { status: number | null; stdout: string } {
  const result = spawnSync(process.execPath, [join(dir, entry)], { cwd: dir, encoding: "utf-8", timeout: 20_000 });
  return { status: result.status, stdout: result.stdout };
}

const dynamicProject = {
  "value.mjs": "export const value = 42;\n",
  "barrel.mjs": 'export { value } from "./value.mjs";\n',
  "consumer.mjs": 'const loaded = await import("./barrel.mjs");\nconsole.log(loaded.value);\n',
};

for (const only of [[], ["inner.mjs", "outer.mjs"], ["outer.mjs", "inner.mjs"]]) {
  test(`a forced barrel retains its dynamic dependency with selection ${JSON.stringify(only)}`, async (t) => {
    const dir = await project(t, {
      "value.mjs": "export const value = 42;\n",
      "inner.mjs": 'export { value } from "./value.mjs";\n',
      "outer.mjs": 'export { value } from "./value.mjs";\nawait import("./inner.mjs");\n',
      "consumer.mjs": 'console.log((await import("./outer.mjs")).value);\n',
    });
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
    const dir = await project(t, {
      "value.mjs": "export const value = 42;\n",
      "inner.mjs": 'export { value } from "./value.mjs";\n',
      "outer.mjs": 'export * from "./inner.mjs";\nexport const own = true;\n',
      "consumer.mjs": 'console.log((await import("./outer.mjs")).value);\n',
    });
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
    const dir = await project(t, {
      "a.mjs": multipleSources ? "export const a = 40;\n" : "export const a = 40; export const b = 2;\n",
      "b.mjs": "export const b = 2;\n",
      "barrel.mjs": multipleSources
        ? 'export { a } from "./a.mjs";\nexport { b } from "./b.mjs";\n'
        : 'export { a, b } from "./a.mjs";\n',
      "consumer.ts": original,
    });
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
    const dir = await project(t, dynamicProject);
    assert.deepEqual(run(dir, "consumer.mjs"), { status: 0, stdout: "42\n" });

    const result = await unbarrelify(options(dir, {}));

    assert.deepEqual(result.deleted, []);
    assert.deepEqual(result.preserved, [
      { path: join(dir, "barrel.mjs"), reason: "dynamic-import", consumers: [join(dir, "consumer.mjs")] },
    ]);
    assert.deepEqual(run(dir, "consumer.mjs"), { status: 0, stdout: "42\n" });
  });

  test("preserves an explicit barrel that is dynamically imported", async (t) => {
    const dir = await project(t, dynamicProject);
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
      const dir = await project(t, dynamicProject);
      const result = await unbarrelify(options(dir, { only: ["barrel.mjs"], ...extra }));

      assert.deepEqual(result.deleted, []);
      assert.deepEqual(result.preserved, [
        { path: join(dir, "barrel.mjs"), reason: "dynamic-import", consumers: [join(dir, "consumer.mjs")] },
      ]);
      assert.ok(existsSync(join(dir, "barrel.mjs")));
    }
  });

  test("still rewrites static consumers and deletes the explicit barrel", async (t) => {
    const dir = await project(t, {
      "value.mjs": "export const value = 42;\n",
      "barrel.mjs": 'export { value } from "./value.mjs";\n',
      "consumer.mjs": 'import { value } from "./barrel.mjs";\nconsole.log(value);\n',
    });
    assert.deepEqual(run(dir, "consumer.mjs"), { status: 0, stdout: "42\n" });

    const result = await unbarrelify(options(dir, { only: ["barrel.mjs"] }));

    assert.deepEqual(result.modified, [join(dir, "consumer.mjs")]);
    assert.deepEqual(result.deleted, [join(dir, "barrel.mjs")]);
    assert.deepEqual(result.preserved, []);
    assert.ok(!existsSync(join(dir, "barrel.mjs")));
    assert.deepEqual(run(dir, "consumer.mjs"), { status: 0, stdout: "42\n" });
  });

  test("only restricts target barrels: nonmatched barrels are not tracked", async (t) => {
    const dir = await project(t, {
      "value.mjs": "export const value = 42;\n",
      "other.mjs": "export const other = 7;\n",
      "barrel.mjs": 'export { value } from "./value.mjs";\n',
      "unselected.mjs": 'export { other } from "./other.mjs";\n',
      "consumer.mjs":
        'const loaded = await import("./barrel.mjs");\nimport { other } from "./unselected.mjs";\nconsole.log(loaded.value, other);\n',
    });
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
    const dir = await project(t, {
      "value.mjs": "export const value = 42;\n",
      "inner.mjs": 'export { value } from "./value.mjs";\n',
      "outer.mjs": 'export { value } from "./inner.mjs";\n',
      "consumer.mjs": 'const loaded = await import("./outer.mjs");\nconsole.log(loaded.value);\n',
    });
    assert.deepEqual(run(dir, "consumer.mjs"), { status: 0, stdout: "42\n" });

    const result = await unbarrelify(options(dir, { only: ["inner.mjs", "outer.mjs"] }));

    assert.deepEqual(result.deleted, []);
    assert.ok(existsSync(join(dir, "inner.mjs")));
    assert.ok(existsSync(join(dir, "outer.mjs")));
    assert.deepEqual(run(dir, "consumer.mjs"), { status: 0, stdout: "42\n" });
  });

  test("handles a namespace consumer of an explicit barrel like ordinary mode", async (t) => {
    const files = {
      "a.mjs": "export const a = 40;\n",
      "b.mjs": "export const b = 2;\n",
      "barrel.mjs": 'export { a } from "./a.mjs";\nexport { b } from "./b.mjs";\n',
      "consumer.mjs": 'import * as ns from "./barrel.mjs";\nconsole.log(ns.a + ns.b);\n',
    };
    const ordinaryDir = await project(t, files);
    const ordinary = await unbarrelify(options(ordinaryDir, {}));
    const dir = await project(t, files);
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
    const dir = await project(t, {
      "value.mjs": "export const value = 42;\n",
      "barrel.mjs": 'export { value } from "./value.mjs";\n',
      "page.vue": '<script setup>\nimport { value } from "./barrel.mjs";\n</script>\n',
    });

    const result = await unbarrelify(options(dir, { only: ["barrel.mjs"] }));

    assert.deepEqual(result.deleted, []);
    assert.deepEqual(result.preserved, [
      { path: join(dir, "barrel.mjs"), reason: "non-ts-import", consumers: [join(dir, "page.vue")] },
    ]);
    assert.ok(existsSync(join(dir, "barrel.mjs")));
  });
});
