import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
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
    "consumer.ts": 'import { value } from "#utils";\nexport const result = value;\n',
    "src/utils/index.ts": 'export { value } from "./value.js";\n',
    "src/utils/value.ts": "export const value = 1;\n",
  });
  await unbarrelify({ cwd, write: true });
  assert.match(await readFile(join(cwd, "consumer.ts"), "utf8"), /from "\.\/src\/utils\/value\.js"/);
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
