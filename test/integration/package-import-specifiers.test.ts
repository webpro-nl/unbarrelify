import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import ts from "typescript";
import { unbarrelify } from "../../src/main.ts";
import { resolveModule } from "../../src/resolver.ts";

async function project(t: TestContext, files: Record<string, string>): Promise<string> {
  const cwd = realpathSync(await mkdtemp(join(tmpdir(), "unbarrelify-package-imports-")));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  for (const [path, body] of Object.entries(files)) {
    const target = join(cwd, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, body);
  }
  return cwd;
}

test("rewrites both consumers of a barrel reached by a TypeScript package import", async (t) => {
  const cwd = await project(t, {
    "package.json": '{"type":"module","imports":{"#utils":"./src/utils/index.ts"}}',
    "tsconfig.json": '{"compilerOptions":{"allowImportingTsExtensions":true,"noEmit":true}}',
    "package-consumer.ts": 'import { value } from "#utils";\nexport const result = value;\n',
    "relative-consumer.ts": 'import { value } from "./src/utils/index.ts";\nexport const result = value;\n',
    "src/utils/index.ts": 'export { value } from "./value.ts";\n',
    "src/utils/value.ts": "export const value = 1;\n",
  });
  const result = await unbarrelify({ cwd, write: true });
  assert.deepEqual(result.deleted, [join(cwd, "src/utils/index.ts")]);
  for (const path of ["package-consumer.ts", "relative-consumer.ts"]) {
    assert.match(await readFile(join(cwd, path), "utf8"), /from "\.\/src\/utils\/value\.ts"/);
  }
});

test("does not copy a package's private star-export key into another package", async (t) => {
  const cwd = await project(t, {
    "producer/package.json": '{"type":"module","imports":{"#internal":"./value.js"}}',
    "producer/barrel.js": 'export * from "#internal";\n',
    "producer/value.js": "export const value = 1;\n",
    "consumer/package.json": '{"type":"module","imports":{"#internal":"./unrelated.js"}}',
    "consumer/unrelated.js": "export const value = 99;\n",
    "consumer/input.js": 'import { value } from "../producer/barrel.js";\nexport const result = value;\n',
  });
  await unbarrelify({ cwd, write: true });
  const from = join(cwd, "consumer/input.js");
  assert.match(await readFile(from, "utf8"), /from "\.\.\/producer\/value\.js"/);
  assert.equal(resolveModule(from, "../producer/value.js", null), join(cwd, "producer/value.js"));
  assert.equal((await import(pathToFileURL(from).href)).result, 1);
});

test("reuses a wildcard package key only when it resolves to the target in the consumer", async (t) => {
  const cwd = await project(t, {
    "package.json": '{"type":"module","imports":{"#lib/*":"./src/*.js"}}',
    "src/index.js": 'export { value } from "./value.js";\n',
    "src/value.js": "export const value = 1;",
    "consumer.js": 'import { value } from "#lib/index";\nexport const result = value;\n',
  });
  await unbarrelify({ cwd, write: true });
  const from = join(cwd, "consumer.js");
  assert.match(await readFile(from, "utf8"), /from "#lib\/value"/);
  assert.equal(resolveModule(from, "#lib/value", null), join(cwd, "src/value.js"));
  assert.equal((await import(pathToFileURL(from).href)).result, 1);
});

test("keeps the ESM output extension when a TypeScript barrel uses a mapped .js target", async (t) => {
  const cwd = await project(t, {
    "package.json": '{"type":"module","imports":{"#utils":"./src/utils/index.js"}}',
    "tsconfig.json": '{"compilerOptions":{"module":"NodeNext","moduleResolution":"NodeNext"}}',
    "consumer.ts": "import { value } from '#utils';\nexport const result = value;\n",
    "src/utils/index.ts": 'export { value } from "./value.js";\n',
    "src/utils/value.ts": "export const value = 1;\n",
  });
  const dry = await unbarrelify({ cwd, write: false });
  const written = await unbarrelify({ cwd, write: true });
  const actual = await readFile(join(cwd, "consumer.ts"), "utf8");
  assert.match(actual, /from '\.\/src\/utils\/value\.js'/);
  assert.deepEqual(dry.modified, written.modified);
  assert.ok(
    stripVTControlCharacters(dry.exampleDiff ?? "")
      .split("\n")
      .includes("+ " + actual.split("\n")[0]),
  );
});

test("keeps a barrel used by a dynamic package import while rewriting a named consumer", async (t) => {
  const cwd = await project(t, {
    "package.json": '{"type":"module","imports":{"#utils":"./src/utils/index.js"}}',
    "consumer.js": 'import { value } from "#utils";\nexport const result = value;\n',
    "dynamic.js": 'export const load = () => import("#utils");\n',
    "src/utils/index.js": 'export { value } from "./value.js";\n',
    "src/utils/value.js": "export const value = 1;\n",
  });
  const result = await unbarrelify({ cwd, write: true });
  assert.deepEqual(result.deleted, []);
  assert.deepEqual(result.preserved, [
    { path: join(cwd, "src/utils/index.js"), reason: "dynamic-import", consumers: [join(cwd, "dynamic.js")] },
  ]);
  assert.match(await readFile(join(cwd, "consumer.js"), "utf8"), /from "\.\/src\/utils\/value\.js"/);
  assert.equal(await readFile(join(cwd, "dynamic.js"), "utf8"), 'export const load = () => import("#utils");\n');
});

function assertBundlerTypeChecks(cwd: string, files: string[]): void {
  const program = ts.createProgram(
    files.map((file) => join(cwd, file)),
    {
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      types: [],
      noEmit: true,
      allowImportingTsExtensions: false,
      skipLibCheck: true,
    },
  );
  assert.deepEqual(
    ts.getPreEmitDiagnostics(program).map((d) => [d.code, ts.flattenDiagnosticMessageText(d.messageText, "\n")]),
    [],
  );
}

test("keeps extensionless TypeScript paths for both direct and cross-package consumers", async (t) => {
  const cwd = await project(t, {
    "app/package.json": '{"type":"module","imports":{"#utils":"./src/barrel.ts"}}',
    "app/input.ts":
      'import { value } from "#utils";\nimport { shared } from "../lib/src/barrel";\nexport const result = value + shared;\n',
    "app/src/barrel.ts": 'export { value } from "./value";\n',
    "app/src/value.ts": "export const value = 1;",
    "lib/package.json": '{"type":"module","imports":{"#internal":"./src/internal.ts"}}',
    "lib/src/barrel.ts": 'export * from "#internal";\n',
    "lib/src/internal.ts": "export const shared = 2;",
  });
  assertBundlerTypeChecks(cwd, ["app/input.ts"]);
  const result = await unbarrelify({ cwd, write: true });
  assert.deepEqual(result.deleted.sort(), [join(cwd, "app/src/barrel.ts"), join(cwd, "lib/src/barrel.ts")]);
  const text = await readFile(join(cwd, "app/input.ts"), "utf8");
  assert.match(text, /from "\.\/src\/value"/);
  assert.match(text, /from "\.\.\/lib\/src\/internal"/);
  assertBundlerTypeChecks(cwd, ["app/input.ts"]);
});

test("reuses the barrel's own private star export for a consumer in the same package", async (t) => {
  const cwd = await project(t, {
    "package.json": '{"type":"module","imports":{"#internal":"./src/internal.js"}}',
    "src/barrel.js": 'export * from "#internal";\n',
    "src/internal.js": "export const value = 1;",
    "consumer.js": 'import { value } from "./src/barrel.js";\nexport const result = value;\n',
  });
  const result = await unbarrelify({ cwd, write: true });
  assert.deepEqual(result.deleted, [join(cwd, "src/barrel.js")]);
  const from = join(cwd, "consumer.js");
  assert.match(await readFile(from, "utf8"), /from "#internal"/);
  assert.equal((await import(pathToFileURL(from).href)).result, 1);
});

test("does not copy a package-private dependency key that resolves to a different package in the consumer", async (t) => {
  const cwd = await project(t, {
    "lib/package.json": '{"type":"module","imports":{"#dep":"original-dep"}}',
    "lib/node_modules/original-dep/package.json": '{"name":"original-dep","type":"module","exports":"./index.js"}',
    "lib/node_modules/original-dep/index.js": "export const value = 1;",
    "lib/barrel.js": 'export { value } from "#dep";\n',
    "app/package.json": '{"type":"module","imports":{"#dep":"./unrelated.js"}}',
    "app/unrelated.js": "export const value = 99;",
    "app/consumer.js": 'import { value } from "../lib/barrel.js";\nexport const result = value;\n',
  });
  const result = await unbarrelify({ cwd, write: true });
  assert.deepEqual(result.deleted, []);
  assert.deepEqual(result.preserved, [
    { path: join(cwd, "lib/barrel.js"), reason: "untraceable-import", consumers: [join(cwd, "app/consumer.js")] },
  ]);
  const from = join(cwd, "app/consumer.js");
  assert.match(await readFile(from, "utf8"), /from "\.\.\/lib\/barrel\.js"/);
  assert.equal((await import(pathToFileURL(from).href)).result, 1);
});
