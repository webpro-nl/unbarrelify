import { describe, it } from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";
import { mkdir, rm, writeFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyRewrites, buildRewrites, buildRewriteItem, reverseRewritesByPos } from "../../src/rewriter.ts";
import { analyzeFile } from "../../src/analyzer.ts";
import { BarrelTracker } from "../../src/tracker.ts";
import type { Context, ExportData, File, ImportData, Name, Rewrites } from "../../src/types.ts";

const DEBUG = false;
function debug(...args: unknown[]) {
  if (DEBUG) console.log(...args);
}

function createTestContext(): Context {
  return {
    base: process.cwd(),
    only: [],
    ext: undefined,
    write: false,
    check: false,
    unsafeNamespace: false,
    organizeImports: false,
    aliases: null,
    projectFiles: [],
    preservedBarrels: new Set(),
    includedBarrels: new Set(),
    fileCache: new Map<string, File>(),
    isPackageEntryPoint: () => false,
    progress: () => {},
    tracker: new BarrelTracker(),
  };
}

async function createTempDir(): Promise<string> {
  const dir = join(tmpdir(), `rewriter-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return realpath(dir);
}

describe("rewriter", () => {
  describe("buildRewriteItem", () => {
    it("creates import rewrite for named import", () => {
      const name: Name = { name: "foo" };
      const importItem: ImportData = { names: [name], type: "named", pos: { start: 0, end: 30 } };
      const exportItem: ExportData = {
        specifier: "./utils",
        pos: { start: 0, end: 25 },
        exportedNames: new Set(["foo", "bar"]),
      };

      const result = buildRewriteItem(name, importItem, exportItem);

      assert.equal(result.type, "import");
      assert.deepEqual(result.named, [name]);
      assert.equal(result.defaultName, undefined);
      assert.equal(result.ns, undefined);
    });

    it("creates import rewrite for default import", () => {
      const name: Name = { name: "default" };
      const importItem: ImportData = { name: "MyDefault", type: "default", pos: { start: 0, end: 35 } };
      const exportItem: ExportData = {
        specifier: "./utils",
        pos: { start: 0, end: 25 },
        exportedNames: new Set(["default"]),
      };

      const result = buildRewriteItem(name, importItem, exportItem);

      assert.equal(result.type, "import");
      assert.equal(result.defaultName, "MyDefault");
      assert.deepEqual(result.named, []);
    });

    it("creates export rewrite for re-export", () => {
      const name: Name = { name: "foo" };
      const importItem: ImportData = { names: [name], type: "export", pos: { start: 0, end: 30 } };
      const exportItem: ExportData = {
        specifier: "./utils",
        pos: { start: 0, end: 25 },
        exportedNames: new Set(["foo"]),
      };

      const result = buildRewriteItem(name, importItem, exportItem);

      assert.equal(result.type, "export");
      assert.deepEqual(result.named, [name]);
    });

    it("preserves external specifier", () => {
      const name: Name = { name: "foo" };
      const importItem: ImportData = { names: [name], type: "named", pos: { start: 0, end: 30 } };
      const exportItem: ExportData = {
        specifier: "lodash",
        pos: { start: 0, end: 25 },
        exportedNames: new Set(["foo"]),
        externalSpecifier: "lodash",
      };

      const result = buildRewriteItem(name, importItem, exportItem);

      assert.equal(result.externalSpecifier, "lodash");
    });

    it("preserves re-exported namespace", () => {
      const name: Name = { name: "utils" };
      const importItem: ImportData = { name: "utils", type: "ns", pos: { start: 0, end: 40 }, members: [] };
      const exportItem: ExportData = {
        specifier: "./utils",
        pos: { start: 0, end: 25 },
        exportedNames: new Set(["foo"]),
        reExportedNs: "utils",
      };

      const result = buildRewriteItem(name, importItem, exportItem);

      assert.equal(result.reExportedNs, "utils");
    });
  });

  describe("reverseRewritesByPos", () => {
    it("sorts rewrites by position descending", () => {
      const rewrites: Rewrites = new Map();
      rewrites.set("10:30", new Map());
      rewrites.set("50:80", new Map());
      rewrites.set("0:10", new Map());

      const result = reverseRewritesByPos(rewrites);

      assert.equal(result.length, 3);
      assert.deepEqual(result[0][0], [50, 80]);
      assert.deepEqual(result[1][0], [10, 30]);
      assert.deepEqual(result[2][0], [0, 10]);
    });

    it("handles empty rewrites", () => {
      const rewrites: Rewrites = new Map();
      const result = reverseRewritesByPos(rewrites);
      assert.equal(result.length, 0);
    });
  });

  describe("applyRewrites", () => {
    it("rewrites named import to point to source file", () => {
      const code = `import { foo } from './barrel';`;
      const sourceFile = ts.createSourceFile("test.ts", code, ts.ScriptTarget.Latest);

      const rewrites: Rewrites = new Map();
      const rewriteMap = new Map();
      rewriteMap.set("/path/to/utils.ts", {
        type: "import" as const,
        named: [{ name: "foo" }],
        members: [],
      });
      rewrites.set("0:31", rewriteMap);

      const result = applyRewrites(sourceFile, rewrites, "/path/to/test.ts", { ext: ".js" });

      assert.ok(result.includes("foo"));
      assert.ok(result.includes("utils.js"));
    });

    it("rewrites default import to point to source file", () => {
      const code = `import MyDefault from './barrel';`;
      const sourceFile = ts.createSourceFile("test.ts", code, ts.ScriptTarget.Latest);

      const rewrites: Rewrites = new Map();
      const rewriteMap = new Map();
      rewriteMap.set("/path/to/utils.ts", {
        type: "import" as const,
        named: [],
        members: [],
        defaultName: "MyDefault",
      });
      rewrites.set("0:33", rewriteMap);

      const result = applyRewrites(sourceFile, rewrites, "/path/to/test.ts", { ext: ".js" });

      assert.ok(result.includes("MyDefault"));
      assert.ok(result.includes("utils.js"));
    });

    it("rewrites aliased import preserving alias", () => {
      const code = `import { foo as bar } from './barrel';`;
      const sourceFile = ts.createSourceFile("test.ts", code, ts.ScriptTarget.Latest);

      const rewrites: Rewrites = new Map();
      const rewriteMap = new Map();
      rewriteMap.set("/path/to/utils.ts", {
        type: "import" as const,
        named: [{ name: "foo", alias: "bar" }],
        members: [],
      });
      rewrites.set("0:38", rewriteMap);

      const result = applyRewrites(sourceFile, rewrites, "/path/to/test.ts", { ext: ".js" });

      assert.ok(result.includes("foo"));
      assert.ok(result.includes("bar"));
      assert.ok(result.includes("utils.js"));
    });

    it("rewrites type-only import preserving type modifier", () => {
      const code = `import type { Foo } from './barrel';`;
      const sourceFile = ts.createSourceFile("test.ts", code, ts.ScriptTarget.Latest);

      const rewrites: Rewrites = new Map();
      const rewriteMap = new Map();
      rewriteMap.set("/path/to/types.ts", {
        type: "import" as const,
        named: [{ name: "Foo", isType: true }],
        members: [],
      });
      rewrites.set("0:36", rewriteMap);

      const result = applyRewrites(sourceFile, rewrites, "/path/to/test.ts", { ext: ".js" });

      assert.ok(result.includes("type"));
      assert.ok(result.includes("Foo"));
      assert.ok(result.includes("types.js"));
    });

    it("rewrites namespace import to point to source file", () => {
      const code = `import * as utils from './barrel';`;
      const sourceFile = ts.createSourceFile("test.ts", code, ts.ScriptTarget.Latest);

      const rewrites: Rewrites = new Map();
      const rewriteMap = new Map();
      rewriteMap.set("/path/to/utils.ts", {
        type: "import" as const,
        named: [],
        members: [],
        reExportedNs: "utils",
      });
      rewrites.set("0:34", rewriteMap);

      const result = applyRewrites(sourceFile, rewrites, "/path/to/test.ts", { ext: ".js" });

      assert.ok(result.includes("* as utils"));
      assert.ok(result.includes("utils.js"));
    });

    it("rewrites re-export to point to source file", () => {
      const code = `export { foo } from './barrel';`;
      const sourceFile = ts.createSourceFile("test.ts", code, ts.ScriptTarget.Latest);

      const rewrites: Rewrites = new Map();
      const rewriteMap = new Map();
      rewriteMap.set("/path/to/utils.ts", {
        type: "export" as const,
        named: [{ name: "foo" }],
        members: [],
      });
      rewrites.set("0:31", rewriteMap);

      const result = applyRewrites(sourceFile, rewrites, "/path/to/test.ts", { ext: ".js" });

      assert.ok(result.includes("export"));
      assert.ok(result.includes("foo"));
      assert.ok(result.includes("utils.js"));
    });

    it("uses external specifier for external packages", () => {
      const code = `import { debounce } from './barrel';`;
      const sourceFile = ts.createSourceFile("test.ts", code, ts.ScriptTarget.Latest);

      const rewrites: Rewrites = new Map();
      const rewriteMap = new Map();
      rewriteMap.set("lodash", {
        type: "import" as const,
        named: [{ name: "debounce" }],
        members: [],
        externalSpecifier: "lodash",
      });
      rewrites.set("0:36", rewriteMap);

      const result = applyRewrites(sourceFile, rewrites, "/path/to/test.ts", { ext: ".js" });

      assert.ok(result.includes("debounce"));
      assert.ok(result.includes("lodash"));
      assert.ok(!result.includes("./"));
    });

    it("handles multiple rewrites in correct order", () => {
      const code = `import { foo } from './barrel1';\nimport { bar } from './barrel2';`;
      const sourceFile = ts.createSourceFile("test.ts", code, ts.ScriptTarget.Latest);

      const rewrites: Rewrites = new Map();

      const rewriteMap1 = new Map();
      rewriteMap1.set("/path/to/utils1.ts", {
        type: "import" as const,
        named: [{ name: "foo" }],
        members: [],
      });
      rewrites.set("0:32", rewriteMap1);

      const rewriteMap2 = new Map();
      rewriteMap2.set("/path/to/utils2.ts", {
        type: "import" as const,
        named: [{ name: "bar" }],
        members: [],
      });
      rewrites.set("33:65", rewriteMap2);

      const result = applyRewrites(sourceFile, rewrites, "/path/to/test.ts", { ext: ".js" });

      assert.ok(result.includes("foo"));
      assert.ok(result.includes("bar"));
      assert.ok(result.includes("utils1.js"));
      assert.ok(result.includes("utils2.js"));
    });

    it("handles namespace re-export", () => {
      const code = `import { utils } from './barrel';`;
      const sourceFile = ts.createSourceFile("test.ts", code, ts.ScriptTarget.Latest);

      const rewrites: Rewrites = new Map();
      const rewriteMap = new Map();
      rewriteMap.set("/path/to/utils.ts", {
        type: "import" as const,
        named: [],
        members: [],
        reExportedNs: "utils",
      });
      rewrites.set("0:33", rewriteMap);

      const result = applyRewrites(sourceFile, rewrites, "/path/to/test.ts", { ext: ".js" });

      assert.ok(result.includes("utils"));
      assert.ok(result.includes("utils.js"));
    });
  });

  describe("buildRewrites", () => {
    it("builds rewrites for named import from barrel", async () => {
      const tempDir = await createTempDir();
      const ctx = createTestContext();

      try {
        const barrelPath = join(tempDir, "index.ts");
        await writeFile(barrelPath, `export * from './utils';`);

        const utilsPath = join(tempDir, "utils.ts");
        await writeFile(utilsPath, `export function foo() {}`);

        const consumerPath = join(tempDir, "consumer.ts");
        await writeFile(consumerPath, `import { foo } from './index';`);

        const analysis = await analyzeFile(consumerPath, ctx);

        const rewrites = await buildRewrites(analysis, consumerPath, ctx);

        assert.ok(rewrites.size > 0);
        assert.ok(ctx.tracker.has(barrelPath));
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    it("builds rewrites for default import from barrel", async () => {
      const tempDir = await createTempDir();
      const ctx = createTestContext();

      try {
        const barrelPath = join(tempDir, "index.ts");
        await writeFile(barrelPath, `export * from './utils';`);

        const utilsPath = join(tempDir, "utils.ts");
        await writeFile(utilsPath, `export default function myFunc() {}`);

        const consumerPath = join(tempDir, "consumer.ts");
        await writeFile(consumerPath, `import myFunc from './index';`);

        const analysis = await analyzeFile(consumerPath, ctx);

        const rewrites = await buildRewrites(analysis, consumerPath, ctx);

        assert.ok(rewrites.size > 0);
        assert.ok(ctx.tracker.has(barrelPath));
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    it("returns empty rewrites for non-barrel imports", async () => {
      const tempDir = await createTempDir();
      const ctx = createTestContext();

      try {
        const utilsPath = join(tempDir, "utils.ts");
        await writeFile(utilsPath, `export function foo() {}`);

        const consumerPath = join(tempDir, "consumer.ts");
        await writeFile(consumerPath, `import { foo } from './utils';`);

        const analysis = await analyzeFile(consumerPath, ctx);

        const rewrites = await buildRewrites(analysis, consumerPath, ctx);

        assert.equal(rewrites.size, 0);
        assert.equal(ctx.tracker.barrels.size, 0);
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    it("returns empty rewrites for barrel files", async () => {
      const tempDir = await createTempDir();
      const ctx = createTestContext();

      try {
        const barrelPath = join(tempDir, "index.ts");
        await writeFile(barrelPath, `export * from './utils';`);

        const utilsPath = join(tempDir, "utils.ts");
        await writeFile(utilsPath, `export function foo() {}`);

        const analysis = await analyzeFile(barrelPath, ctx);

        const rewrites = await buildRewrites(analysis, barrelPath, ctx);

        assert.equal(rewrites.size, 0);
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    it("resolves through chained barrels", async () => {
      const tempDir = await createTempDir();
      const ctx = createTestContext();

      try {
        const subDir = join(tempDir, "sub");
        await mkdir(subDir, { recursive: true });

        const implPath = join(subDir, "impl.ts");
        await writeFile(implPath, `export function foo() {}`);

        const innerBarrelPath = join(subDir, "index.ts");
        await writeFile(innerBarrelPath, `export * from './impl';`);

        const outerBarrelPath = join(tempDir, "index.ts");
        await writeFile(outerBarrelPath, `export * from './sub';`);

        const consumerPath = join(tempDir, "consumer.ts");
        await writeFile(consumerPath, `import { foo } from './index';`);

        const analysis = await analyzeFile(consumerPath, ctx);

        const rewrites = await buildRewrites(analysis, consumerPath, ctx);

        assert.ok(rewrites.size > 0);
        assert.ok(ctx.tracker.has(outerBarrelPath));
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    it("resolves through cyclic star re-exports between barrels", async () => {
      const tempDir = await createTempDir();
      const ctx = createTestContext();

      try {
        const leafPath = join(tempDir, "leaf.ts");
        await writeFile(leafPath, `export const foo = 1;`);

        const barrelAPath = join(tempDir, "a.ts");
        await writeFile(barrelAPath, `export * from './b';\nexport { foo } from './leaf';`);

        const barrelBPath = join(tempDir, "b.ts");
        await writeFile(barrelBPath, `export * from './a';`);

        const consumerPath = join(tempDir, "consumer.ts");
        await writeFile(consumerPath, `import { foo } from './a';`);

        const analysis = await analyzeFile(consumerPath, ctx);

        const rewrites = await buildRewrites(analysis, consumerPath, ctx);

        const targets = [...rewrites.values()].flatMap((posRewrites) => [...posRewrites.keys()]);
        assert.deepEqual(targets, [leafPath]);
        assert.equal(ctx.tracker.untraceableImports.length, 0);
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    it("handles aliased imports", async () => {
      const tempDir = await createTempDir();
      const ctx = createTestContext();

      try {
        const barrelPath = join(tempDir, "index.ts");
        await writeFile(barrelPath, `export * from './utils';`);

        const utilsPath = join(tempDir, "utils.ts");
        await writeFile(utilsPath, `export function foo() {}`);

        const consumerPath = join(tempDir, "consumer.ts");
        await writeFile(consumerPath, `import { foo as bar } from './index';`);

        const analysis = await analyzeFile(consumerPath, ctx);

        const rewrites = await buildRewrites(analysis, consumerPath, ctx);

        assert.ok(rewrites.size > 0);
        assert.ok(ctx.tracker.has(barrelPath));
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    it("handles type-only imports", async () => {
      const tempDir = await createTempDir();
      const ctx = createTestContext();

      try {
        const barrelPath = join(tempDir, "index.ts");
        await writeFile(barrelPath, `export * from './types';`);

        const typesPath = join(tempDir, "types.ts");
        await writeFile(typesPath, `export interface Foo { name: string; }`);

        const consumerPath = join(tempDir, "consumer.ts");
        await writeFile(consumerPath, `import type { Foo } from './index';`);

        const analysis = await analyzeFile(consumerPath, ctx);

        const rewrites = await buildRewrites(analysis, consumerPath, ctx);

        assert.ok(rewrites.size > 0);
        assert.ok(ctx.tracker.has(barrelPath));
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    it("handles re-exports", async () => {
      const tempDir = await createTempDir();
      const ctx = createTestContext();

      try {
        const barrelPath = join(tempDir, "index.ts");
        await writeFile(barrelPath, `export * from './utils';`);

        const utilsPath = join(tempDir, "utils.ts");
        await writeFile(utilsPath, `export function foo() {}`);

        const consumerPath = join(tempDir, "consumer.ts");
        await writeFile(consumerPath, `export { foo } from './index';\nconst x = 1;`);

        const analysis = await analyzeFile(consumerPath, ctx);
        debug("Re-export analysis isBarrel:", analysis.isBarrel);
        debug("Re-export analysis imports:", [...analysis.imports.entries()]);

        const rewrites = await buildRewrites(analysis, consumerPath, ctx);
        debug("Re-export rewrites size:", rewrites.size);
        debug("Re-export ctx.tracker.barrels:", [...ctx.tracker.barrels.keys()]);

        assert.ok(rewrites.size > 0);
        assert.ok(ctx.tracker.has(barrelPath));
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    it("builds rewrites for namespace import from single-source barrel", async () => {
      const tempDir = await createTempDir();
      const ctx = createTestContext();

      try {
        const barrelPath = join(tempDir, "index.ts");
        await writeFile(barrelPath, `export * from './utils';`);

        const utilsPath = join(tempDir, "utils.ts");
        await writeFile(utilsPath, `export function foo() {}\nexport const bar = 42;`);

        const consumerPath = join(tempDir, "consumer.ts");
        await writeFile(consumerPath, `import * as lib from './index';`);

        const analysis = await analyzeFile(consumerPath, ctx);

        const rewrites = await buildRewrites(analysis, consumerPath, ctx);

        assert.ok(rewrites.size > 0);
        assert.ok(ctx.tracker.has(barrelPath));
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    it("does not build rewrites for namespace import from multi-source barrel", async () => {
      const tempDir = await createTempDir();
      const ctx = createTestContext();

      try {
        const barrelPath = join(tempDir, "index.ts");
        await writeFile(barrelPath, `export * from './utils';\nexport * from './helpers';`);

        const utilsPath = join(tempDir, "utils.ts");
        await writeFile(utilsPath, `export function foo() {}`);

        const helpersPath = join(tempDir, "helpers.ts");
        await writeFile(helpersPath, `export function bar() {}`);

        const consumerPath = join(tempDir, "consumer.ts");
        await writeFile(consumerPath, `import * as lib from './index';`);

        const analysis = await analyzeFile(consumerPath, ctx);

        const rewrites = await buildRewrites(analysis, consumerPath, ctx);

        assert.equal(rewrites.size, 0);
        assert.ok(ctx.tracker.has(barrelPath));
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    it("does not rewrite to files that export nothing via star re-export", async () => {
      const tempDir = await createTempDir();
      const ctx = createTestContext();

      try {
        const barrelPath = join(tempDir, "index.ts");
        await writeFile(barrelPath, `export type * from './context';\nexport type * from './empty';`);

        const contextPath = join(tempDir, "context.ts");
        await writeFile(contextPath, `export type APIContext = { url: URL };`);

        const emptyPath = join(tempDir, "empty.ts");
        await writeFile(emptyPath, `export {};`);

        const consumerPath = join(tempDir, "consumer.ts");
        await writeFile(consumerPath, `import type { APIContext } from './index';`);

        const analysis = await analyzeFile(consumerPath, ctx);

        const rewrites = await buildRewrites(analysis, consumerPath, ctx);

        assert.equal(rewrites.size, 1);
        const posRewrites = [...rewrites.values()][0];
        assert.equal(posRewrites.size, 1);
        const [targetPath] = [...posRewrites.keys()];
        assert.ok(targetPath.endsWith("context.ts"));
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });
  });
});
