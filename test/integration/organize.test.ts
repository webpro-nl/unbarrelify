import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { unbarrelify } from "../../src/index.ts";
import { copyFixture } from "../helpers.ts";

const exec = promisify(execFile);

test("organizing preserves statement boundaries around imports without semicolons", async (t) => {
  const dir = await copyFixture(t, "organize-asi");
  const consumer = join(dir, "consumer.ts");
  const before = await exec(process.execPath, [consumer], { timeout: 10_000 });
  assert.equal(before.stdout, "1\n2\n");
  await unbarrelify({ cwd: dir, files: ["*.ts"], ext: ".ts", write: true, organizeImports: true });
  const after = await exec(process.execPath, [consumer], { timeout: 10_000 });
  assert.equal(after.stdout, "1\n2\n");
});

test("organizing through the public API preserves exports and effect order", async (t) => {
  const dir = await copyFixture(t, "organize-effect-order");
  const identity = await stat(dir);
  const consumerPath = join(dir, "consumer.ts");

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

  const current = await stat(dir);
  assert.equal(current.dev, identity.dev);
  assert.equal(current.ino, identity.ino);
});
