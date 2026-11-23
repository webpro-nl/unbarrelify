import { test } from "node:test";
import assert from "node:assert/strict";
import { checkIsBarrel, analyzeFile, getExportedNames, buildExportMap, buildImportMap } from "../../src/analyzer.ts";
import ts from "typescript";
import { join } from "node:path";
import type { Context, File } from "../../src/types.ts";
import { fixture, read } from "../helpers.ts";

function createTestContext(): Context {
  return {
    base: process.cwd(),
    ext: undefined,
    write: false,
    check: false,
    unsafeNamespace: false,
    organizeImports: false,
    aliases: null,
    files: [],
    preservedBarrels: new Set(),
    includedBarrels: new Set(),
    fileCache: new Map<string, File>(),
    sourceFileCache: new Map(),
    isPackageEntryPoint: () => false,
    progress: () => {},
  };
}

test("checkIsBarrel: returns true for file with only re-exports", () => {
  const code = `export * from './foo';
export { bar } from './bar';`;
  const sourceFile = ts.createSourceFile("test.ts", code, ts.ScriptTarget.Latest);
  assert.equal(checkIsBarrel(sourceFile), true);
});

test("checkIsBarrel: returns true for single re-export", () => {
  const code = `export * from './foo';`;
  const sourceFile = ts.createSourceFile("test.ts", code, ts.ScriptTarget.Latest);
  assert.equal(checkIsBarrel(sourceFile), true);
});

test("checkIsBarrel: returns false for empty file", () => {
  const code = ``;
  const sourceFile = ts.createSourceFile("test.ts", code, ts.ScriptTarget.Latest);
  assert.equal(checkIsBarrel(sourceFile), false);
});

test("checkIsBarrel: returns false for file with variable declaration", () => {
  const code = `export * from './foo';
const x = 1;`;
  const sourceFile = ts.createSourceFile("test.ts", code, ts.ScriptTarget.Latest);
  assert.equal(checkIsBarrel(sourceFile), false);
});

test("checkIsBarrel: returns false for file with function declaration", () => {
  const code = `export * from './foo';
export function bar() {}`;
  const sourceFile = ts.createSourceFile("test.ts", code, ts.ScriptTarget.Latest);
  assert.equal(checkIsBarrel(sourceFile), false);
});

test("checkIsBarrel: returns false for file with import statement", () => {
  const code = `import { foo } from './foo';
export { foo };`;
  const sourceFile = ts.createSourceFile("test.ts", code, ts.ScriptTarget.Latest);
  assert.equal(checkIsBarrel(sourceFile), false);
});

test("checkIsBarrel: returns false for file with class declaration", () => {
  const code = `export * from './foo';
export class MyClass {}`;
  const sourceFile = ts.createSourceFile("test.ts", code, ts.ScriptTarget.Latest);
  assert.equal(checkIsBarrel(sourceFile), false);
});

test("checkIsBarrel: returns false for file with interface declaration", () => {
  const code = `export * from './foo';
export interface MyInterface {}`;
  const sourceFile = ts.createSourceFile("test.ts", code, ts.ScriptTarget.Latest);
  assert.equal(checkIsBarrel(sourceFile), false);
});

test("checkIsBarrel: returns false for file with type alias", () => {
  const code = `export * from './foo';
export type MyType = string;`;
  const sourceFile = ts.createSourceFile("test.ts", code, ts.ScriptTarget.Latest);
  assert.equal(checkIsBarrel(sourceFile), false);
});

test("checkIsBarrel: returns true for named re-exports only", () => {
  const code = `export { foo, bar } from './utils';
export { baz as qux } from './helpers';`;
  const sourceFile = ts.createSourceFile("test.ts", code, ts.ScriptTarget.Latest);
  assert.equal(checkIsBarrel(sourceFile), true);
});

test("checkIsBarrel: returns true for namespace re-export", () => {
  const code = `export * as utils from './utils';`;
  const sourceFile = ts.createSourceFile("test.ts", code, ts.ScriptTarget.Latest);
  assert.equal(checkIsBarrel(sourceFile), true);
});

const testDir = fixture("exported-names");

test("getExportedNames: finds exported function", async () => {
  const filePath = join(testDir, "func.ts");
  const names = await getExportedNames(filePath);
  assert.ok(names.has("foo"));
});

test("getExportedNames: finds exported const", async () => {
  const filePath = join(testDir, "const.ts");
  const names = await getExportedNames(filePath);
  assert.ok(names.has("bar"));
});

test("getExportedNames: finds default export", async () => {
  const filePath = join(testDir, "default.ts");
  const names = await getExportedNames(filePath);
  assert.ok(names.has("default"));
});

test("getExportedNames: finds named exports in export declaration", async () => {
  const filePath = join(testDir, "named.ts");
  const names = await getExportedNames(filePath);
  assert.ok(names.has("x"));
});

test("getExportedNames: finds exported class", async () => {
  const filePath = join(testDir, "class.ts");
  const names = await getExportedNames(filePath);
  assert.ok(names.has("MyClass"));
});

test("getExportedNames: finds exported interface", async () => {
  const filePath = join(testDir, "interface.ts");
  const names = await getExportedNames(filePath);
  assert.ok(names.has("MyInterface"));
});

test("getExportedNames: finds exported type alias", async () => {
  const filePath = join(testDir, "type.ts");
  const names = await getExportedNames(filePath);
  assert.ok(names.has("MyType"));
});

test("getExportedNames: finds exported enum", async () => {
  const filePath = join(testDir, "enum.ts");
  const names = await getExportedNames(filePath);
  assert.ok(names.has("MyEnum"));
});

const analyzeTestDir = fixture("analyze-file");

test("analyzeFile: identifies barrel file correctly", async () => {
  const ctx = createTestContext();

  const barrelPath = join(analyzeTestDir, "barrel.ts");

  const result = await analyzeFile(barrelPath, ctx);
  assert.equal(result.isBarrel, true);
});

test("analyzeFile: identifies non-barrel file correctly", async () => {
  const ctx = createTestContext();
  const filePath = join(analyzeTestDir, "non-barrel.ts");

  const result = await analyzeFile(filePath, ctx);
  assert.equal(result.isBarrel, false);
});

test("analyzeFile: caches file analysis results", async () => {
  const ctx = createTestContext();
  const filePath = join(analyzeTestDir, "cached.ts");

  const result1 = await analyzeFile(filePath, ctx);
  const result2 = await analyzeFile(filePath, ctx);

  assert.strictEqual(result1, result2);
});

test("analyzeFile: returns sourceFile AST", async () => {
  const ctx = createTestContext();
  const filePath = join(analyzeTestDir, "ast.ts");

  const result = await analyzeFile(filePath, ctx);
  assert.ok(result.sourceFile);
  assert.equal(result.sourceFile.fileName, filePath);
});

const exportMapTestDir = fixture("export-map");

test("buildExportMap: maps star re-export to resolved path", async () => {
  const sourcePath = join(exportMapTestDir, "source.ts");
  const barrelPath = join(exportMapTestDir, "barrel.ts");

  const sourceFile = ts.createSourceFile(barrelPath, await read(barrelPath), ts.ScriptTarget.Latest);
  Object.defineProperty(sourceFile, "fileName", { value: barrelPath });

  const exportMap = await buildExportMap(sourceFile, null);

  assert.equal(exportMap.size, 1);
  assert.ok(exportMap.has(sourcePath));

  const exportData = exportMap.get(sourcePath)!;
  assert.equal(exportData.specifier, "./source");
  assert.equal(exportData.exportStar, true);
  assert.ok(exportData.exportedNames.has("foo"));
  assert.ok(exportData.exportedNames.has("bar"));
});

test("buildExportMap: maps named re-export to resolved path", async () => {
  const sourcePath = join(exportMapTestDir, "named-source.ts");
  const barrelPath = join(exportMapTestDir, "named-barrel.ts");

  const sourceFile = ts.createSourceFile(barrelPath, await read(barrelPath), ts.ScriptTarget.Latest);
  Object.defineProperty(sourceFile, "fileName", { value: barrelPath });

  const exportMap = await buildExportMap(sourceFile, null);

  assert.equal(exportMap.size, 1);
  assert.ok(exportMap.has(sourcePath));
});

test("buildExportMap: captures namespace re-export", async () => {
  const sourcePath = join(exportMapTestDir, "ns-source.ts");
  const barrelPath = join(exportMapTestDir, "ns-barrel.ts");

  const sourceFile = ts.createSourceFile(barrelPath, await read(barrelPath), ts.ScriptTarget.Latest);
  Object.defineProperty(sourceFile, "fileName", { value: barrelPath });

  const exportMap = await buildExportMap(sourceFile, null);

  assert.equal(exportMap.size, 1);
  const exportData = exportMap.get(sourcePath)!;
  assert.deepEqual(exportData.reExportedNs, new Set(["utils"]));
});

test("buildExportMap: returns empty map for non-export file", async () => {
  const filePath = join(exportMapTestDir, "no-exports.ts");

  const sourceFile = ts.createSourceFile(filePath, await read(filePath), ts.ScriptTarget.Latest);
  Object.defineProperty(sourceFile, "fileName", { value: filePath });

  const exportMap = await buildExportMap(sourceFile, null);

  assert.equal(exportMap.size, 0);
});

test("buildExportMap: merges multiple exports from same source", async () => {
  const sourcePath = join(exportMapTestDir, "multi-source.ts");
  const barrelPath = join(exportMapTestDir, "multi-barrel.ts");

  const barrelCode = await read(barrelPath);

  const sourceFile = ts.createSourceFile(barrelPath, barrelCode, ts.ScriptTarget.Latest);
  Object.defineProperty(sourceFile, "fileName", { value: barrelPath });

  const exportMap = await buildExportMap(sourceFile, null);

  assert.equal(exportMap.size, 1);
  assert.ok(exportMap.has(sourcePath));
});

const importMapTestDir = fixture("import-map");

test("buildImportMap: maps named import to resolved path", async () => {
  const sourcePath = join(importMapTestDir, "source.ts");
  const consumerPath = join(importMapTestDir, "consumer.ts");

  const consumerCode = await read(consumerPath);

  const sourceFile = ts.createSourceFile(consumerPath, consumerCode, ts.ScriptTarget.Latest);
  Object.defineProperty(sourceFile, "fileName", { value: consumerPath });

  const importMap = await buildImportMap(sourceFile, null);

  assert.equal(importMap.size, 1);
  assert.ok(importMap.has(sourcePath));

  const importSet = importMap.get(sourcePath)!;
  assert.equal(importSet.size, 1);

  const importData = [...importSet][0];
  assert.equal(importData.type, "named");
  assert.ok(importData.names);
  assert.equal(importData.names[0].name, "foo");
});

test("buildImportMap: maps default import to resolved path", async () => {
  const sourcePath = join(importMapTestDir, "default-source.ts");
  const consumerPath = join(importMapTestDir, "default-consumer.ts");

  const consumerCode = await read(consumerPath);

  const sourceFile = ts.createSourceFile(consumerPath, consumerCode, ts.ScriptTarget.Latest);
  Object.defineProperty(sourceFile, "fileName", { value: consumerPath });

  const importMap = await buildImportMap(sourceFile, null);

  assert.equal(importMap.size, 1);
  assert.ok(importMap.has(sourcePath));

  const importSet = importMap.get(sourcePath)!;
  const importData = [...importSet][0];
  assert.equal(importData.type, "default");
  assert.equal(importData.name, "myDefault");
});

test("buildImportMap: maps namespace import to resolved path", async () => {
  const sourcePath = join(importMapTestDir, "ns-source.ts");
  const consumerPath = join(importMapTestDir, "ns-consumer.ts");

  const consumerCode = await read(consumerPath);

  const sourceFile = ts.createSourceFile(consumerPath, consumerCode, ts.ScriptTarget.Latest);
  Object.defineProperty(sourceFile, "fileName", { value: consumerPath });

  const importMap = await buildImportMap(sourceFile, null);

  assert.equal(importMap.size, 1);
  assert.ok(importMap.has(sourcePath));

  const importSet = importMap.get(sourcePath)!;
  const importData = [...importSet][0];
  assert.equal(importData.type, "ns");
  assert.equal(importData.name, "utils");
});

test("buildImportMap: maps aliased import to resolved path", async () => {
  const sourcePath = join(importMapTestDir, "alias-source.ts");
  const consumerPath = join(importMapTestDir, "alias-consumer.ts");

  const consumerCode = await read(consumerPath);

  const sourceFile = ts.createSourceFile(consumerPath, consumerCode, ts.ScriptTarget.Latest);
  Object.defineProperty(sourceFile, "fileName", { value: consumerPath });

  const importMap = await buildImportMap(sourceFile, null);

  assert.equal(importMap.size, 1);
  assert.ok(importMap.has(sourcePath));

  const importSet = importMap.get(sourcePath)!;
  const importData = [...importSet][0];
  assert.equal(importData.type, "as");
  assert.ok(importData.names);
  assert.equal(importData.names[0].name, "originalName");
  assert.equal(importData.names[0].alias, "aliasedName");
});

test("buildImportMap: handles type-only imports", async () => {
  const sourcePath = join(importMapTestDir, "type-source.ts");
  const consumerPath = join(importMapTestDir, "type-consumer.ts");

  const consumerCode = await read(consumerPath);

  const sourceFile = ts.createSourceFile(consumerPath, consumerCode, ts.ScriptTarget.Latest);
  Object.defineProperty(sourceFile, "fileName", { value: consumerPath });

  const importMap = await buildImportMap(sourceFile, null);

  assert.equal(importMap.size, 1);
  assert.ok(importMap.has(sourcePath));

  const importSet = importMap.get(sourcePath)!;
  const importData = [...importSet][0];
  assert.ok(importData.names);
  assert.equal(importData.names[0].isType, true);
});

test("buildImportMap: handles re-exports", async () => {
  const sourcePath = join(importMapTestDir, "reexport-source.ts");
  const barrelPath = join(importMapTestDir, "reexport-barrel.ts");

  const barrelCode = await read(barrelPath);

  const sourceFile = ts.createSourceFile(barrelPath, barrelCode, ts.ScriptTarget.Latest);
  Object.defineProperty(sourceFile, "fileName", { value: barrelPath });

  const importMap = await buildImportMap(sourceFile, null);

  assert.equal(importMap.size, 1);
  assert.ok(importMap.has(sourcePath));

  const importSet = importMap.get(sourcePath)!;
  const importData = [...importSet][0];
  assert.equal(importData.type, "export");
});

test("buildImportMap: handles star re-exports", async () => {
  const sourcePath = join(importMapTestDir, "star-source.ts");
  const barrelPath = join(importMapTestDir, "star-barrel.ts");

  const barrelCode = await read(barrelPath);

  const sourceFile = ts.createSourceFile(barrelPath, barrelCode, ts.ScriptTarget.Latest);
  Object.defineProperty(sourceFile, "fileName", { value: barrelPath });

  const importMap = await buildImportMap(sourceFile, null);

  assert.equal(importMap.size, 1);
  assert.ok(importMap.has(sourcePath));

  const importSet = importMap.get(sourcePath)!;
  const importData = [...importSet][0];
  assert.equal(importData.type, "export");
  assert.equal(importData.name, "*");
});

test("buildImportMap: returns empty map for file with no imports", async () => {
  const filePath = join(importMapTestDir, "no-imports.ts");

  const sourceFile = ts.createSourceFile(filePath, await read(filePath), ts.ScriptTarget.Latest);
  Object.defineProperty(sourceFile, "fileName", { value: filePath });

  const importMap = await buildImportMap(sourceFile, null);

  assert.equal(importMap.size, 0);
});

test("buildImportMap: handles multiple imports from same source", async () => {
  const sourcePath = join(importMapTestDir, "multi-import-source.ts");
  const consumerPath = join(importMapTestDir, "multi-import-consumer.ts");

  const consumerCode = await read(consumerPath);

  const sourceFile = ts.createSourceFile(consumerPath, consumerCode, ts.ScriptTarget.Latest);
  Object.defineProperty(sourceFile, "fileName", { value: consumerPath });

  const importMap = await buildImportMap(sourceFile, null);

  assert.equal(importMap.size, 1);
  assert.ok(importMap.has(sourcePath));

  const importSet = importMap.get(sourcePath)!;
  assert.equal(importSet.size, 2);
});
