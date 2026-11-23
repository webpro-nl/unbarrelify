import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { unbarrelify } from "../../src/index.ts";

const exec = promisify(execFile);

test("organizing preserves statement boundaries around imports without semicolons", async (t) => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "unbarrelify-organize-asi-")));
  t.after(() => rm(dir, { recursive: true }));
  await writeFile(join(dir, "value.ts"), "export const foo = 1, bar = 2;\n");
  await writeFile(join(dir, "barrel.ts"), 'export { foo } from "./value.ts";\n');
  const consumer = join(dir, "consumer.ts");
  await writeFile(
    consumer,
    `import { foo } from "./barrel.ts";
console.log(foo)
import { bar } from "./value.ts";
(() => console.log(bar))();
`,
  );
  const before = await exec(process.execPath, [consumer], { timeout: 10_000 });
  assert.equal(before.stdout, "1\n2\n");
  await unbarrelify({ cwd: dir, files: ["*.ts"], ext: ".ts", write: true, organizeImports: true });
  const after = await exec(process.execPath, [consumer], { timeout: 10_000 });
  assert.equal(after.stdout, "1\n2\n");
});

test("organizing through the public API preserves exports and effect order", async (t) => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "unbarrelify-organize-")));
  const identity = await stat(dir);
  t.after(async () => {
    const current = await stat(dir);
    assert.equal(current.dev, identity.dev);
    assert.equal(current.ino, identity.ino);
    await rm(dir, { recursive: true });
  });

  const consumerPath = join(dir, "consumer.ts");
  await writeFile(join(dir, "value.ts"), 'console.log("value");\nexport const foo = 1;\nexport const bar = 2;\n');
  await writeFile(join(dir, "barrel.ts"), 'export { foo } from "./value.ts";\n');
  await writeFile(join(dir, "effect.ts"), 'console.log("effect");\n');
  await writeFile(
    consumerPath,
    `#!/usr/bin/env node
"use client";
// Keep the public value.
import { foo } from "./barrel.ts";
export const saved = foo;
console.log("before", saved);
import "./effect.ts";
// Keep the calculation between imports.
function sum(a: number, b: number) { return a + b; }
import { bar } from "./value.ts";
console.log("after", saved, bar);
export const total = sum(saved, bar);
`,
  );

  const script = `import { saved, total } from ${JSON.stringify(pathToFileURL(consumerPath).href)};
console.log(JSON.stringify({ saved, total }));`;
  const expected = 'value\neffect\nbefore 1\nafter 1 2\n{"saved":1,"total":3}\n';
  const before = await exec(process.execPath, ["--input-type=module", "-e", script], { timeout: 10_000 });
  assert.equal(before.stdout, expected);

  const result = await unbarrelify({
    cwd: dir,
    files: ["*.ts"],
    ext: ".ts",
    write: true,
    organizeImports: true,
  });
  assert.deepEqual(result.untraceableImports, []);
  assert.ok(result.modified.includes(consumerPath));
  const after = await exec(process.execPath, ["--input-type=module", "-e", script], { timeout: 10_000 });
  assert.equal(after.stdout, expected);

  const content = await readFile(consumerPath, "utf-8");
  assert.ok(content.startsWith('#!/usr/bin/env node\n"use client";\n'));
  assert.ok(content.includes("// Keep the public value."));
  assert.ok(content.includes("// Keep the calculation between imports."));
  assert.ok(!content.includes("./barrel.ts"));
  assert.equal((content.match(/from "\.\/value\.ts"/g) || []).length, 2);
});
