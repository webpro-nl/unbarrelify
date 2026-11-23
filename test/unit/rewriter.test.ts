import { describe, it } from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";
import { join } from "node:path";
import { applyRewrites, buildRewrites, buildRewriteItem, reverseRewritesByPos } from "../../src/rewriter.ts";
import { analyzeFile } from "../../src/analyzer.ts";
import { BarrelTracker } from "../../src/tracker.ts";
import type { Context, ExportData, File, ImportData, Name, Rewrites } from "../../src/types.ts";
import { fixture } from "../helpers.ts";

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
    sourceFileCache: new Map(),
    isPackageEntryPoint: () => false,
    progress: () => {},
    tracker: new BarrelTracker(),
  };
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
        reExportedNs: new Set(["utils"]),
      };

      const result = buildRewriteItem(name, importItem, exportItem, true);

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
    const starBarrelDir = fixture("rewrites-star-barrel");

    it("builds rewrites for named import from barrel", async () => {
      const ctx = createTestContext();
      const barrelPath = join(starBarrelDir, "index.ts");
      const consumerPath = join(starBarrelDir, "named.ts");

      const analysis = await analyzeFile(consumerPath, ctx);

      const rewrites = await buildRewrites(analysis, consumerPath, ctx);

      assert.ok(rewrites.size > 0);
      assert.ok(ctx.tracker.has(barrelPath));
    });

    it("builds rewrites for default import from barrel", async () => {
      const dir = fixture("rewrites-default-export");
      const ctx = createTestContext();
      const barrelPath = join(dir, "index.ts");
      const consumerPath = join(dir, "consumer.ts");

      const analysis = await analyzeFile(consumerPath, ctx);

      const rewrites = await buildRewrites(analysis, consumerPath, ctx);

      assert.ok(rewrites.size > 0);
      assert.ok(ctx.tracker.has(barrelPath));
    });

    it("returns empty rewrites for non-barrel imports", async () => {
      const ctx = createTestContext();
      const consumerPath = join(starBarrelDir, "direct.ts");

      const analysis = await analyzeFile(consumerPath, ctx);

      const rewrites = await buildRewrites(analysis, consumerPath, ctx);

      assert.equal(rewrites.size, 0);
      assert.equal(ctx.tracker.barrels.size, 0);
    });

    it("returns empty rewrites for barrel files", async () => {
      const ctx = createTestContext();
      const barrelPath = join(starBarrelDir, "index.ts");

      const analysis = await analyzeFile(barrelPath, ctx);

      const rewrites = await buildRewrites(analysis, barrelPath, ctx);

      assert.equal(rewrites.size, 0);
    });

    it("resolves through chained barrels", async () => {
      const dir = fixture("rewrites-chained-barrels");
      const ctx = createTestContext();
      const outerBarrelPath = join(dir, "index.ts");
      const consumerPath = join(dir, "consumer.ts");

      const analysis = await analyzeFile(consumerPath, ctx);

      const rewrites = await buildRewrites(analysis, consumerPath, ctx);

      assert.ok(rewrites.size > 0);
      assert.ok(ctx.tracker.has(outerBarrelPath));
    });

    it("resolves through cyclic star re-exports between barrels", async () => {
      const dir = fixture("rewrites-cyclic-stars");
      const ctx = createTestContext();
      const leafPath = join(dir, "leaf.ts");
      const consumerPath = join(dir, "consumer.ts");

      const analysis = await analyzeFile(consumerPath, ctx);

      const rewrites = await buildRewrites(analysis, consumerPath, ctx);

      const targets = [...rewrites.values()].flatMap((posRewrites) => [...posRewrites.keys()]);
      assert.deepEqual(targets, [leafPath]);
      assert.equal(ctx.tracker.untraceableImports.length, 0);
    });

    it("revisits a barrel under another name in a cyclic export graph", async () => {
      const dir = fixture("rewrites-cyclic-renamed");
      const ctx = createTestContext();
      const leafPath = join(dir, "leaf.ts");
      const consumerPath = join(dir, "consumer.ts");
      const analysis = await analyzeFile(consumerPath, ctx);
      const rewrites = await buildRewrites(analysis, consumerPath, ctx);

      assert.deepEqual(
        [...rewrites.values()].flatMap((group) => [...group.keys()]),
        [leafPath],
      );
      assert.equal(ctx.tracker.untraceableImports.length, 0);
      assert.match(applyRewrites(analysis.sourceFile!, rewrites, consumerPath), /b as value/);
    });

    it("prefers a local export over an earlier package star re-export", async () => {
      const dir = fixture("rewrites-package-star-local");
      const ctx = createTestContext();
      const leafPath = join(dir, "leaf.ts");
      const consumerPath = join(dir, "consumer.ts");

      const analysis = await analyzeFile(consumerPath, ctx);
      const rewrites = await buildRewrites(analysis, consumerPath, ctx);

      const targets = [...rewrites.values()].flatMap((posRewrites) =>
        [...posRewrites].map(([target, rewrite]) => [target, rewrite.named.map((item) => item.name)]),
      );
      assert.deepEqual(targets, [
        [leafPath, ["foo"]],
        ["node:path", ["join"]],
      ]);
      assert.equal(ctx.tracker.untraceableImports.length, 0);
    });

    it("leaves a name untraceable when several package star re-exports could own it", async () => {
      const dir = fixture("rewrites-package-stars-ambiguous");
      const ctx = createTestContext();
      const consumerPath = join(dir, "consumer.ts");

      const analysis = await analyzeFile(consumerPath, ctx);
      const rewrites = await buildRewrites(analysis, consumerPath, ctx);

      assert.equal(rewrites.size, 0);
      assert.deepEqual(
        ctx.tracker.untraceableImports.map((item) => item.name),
        ["homedir"],
      );
    });

    for (const [label, barrel] of [
      ["an earlier star re-export", "first"],
      ["star re-exports of both sources", "both"],
    ]) {
      it(`prefers a named re-export over ${label} of the same name`, async () => {
        const dir = fixture("rewrites-named-over-star");
        const ctx = createTestContext();
        const yPath = join(dir, "y.ts");
        const consumerPath = join(dir, `${barrel}-consumer.ts`);

        const analysis = await analyzeFile(consumerPath, ctx);
        const rewrites = await buildRewrites(analysis, consumerPath, ctx);

        const targets = [...rewrites.values()].flatMap((posRewrites) => [...posRewrites.keys()]);
        assert.deepEqual(targets, [yPath]);
      });
    }

    it("handles aliased imports", async () => {
      const ctx = createTestContext();
      const barrelPath = join(starBarrelDir, "index.ts");
      const consumerPath = join(starBarrelDir, "aliased.ts");

      const analysis = await analyzeFile(consumerPath, ctx);

      const rewrites = await buildRewrites(analysis, consumerPath, ctx);

      assert.ok(rewrites.size > 0);
      assert.ok(ctx.tracker.has(barrelPath));
    });

    it("handles type-only imports", async () => {
      const dir = fixture("rewrites-type-star");
      const ctx = createTestContext();
      const barrelPath = join(dir, "index.ts");
      const consumerPath = join(dir, "consumer.ts");

      const analysis = await analyzeFile(consumerPath, ctx);

      const rewrites = await buildRewrites(analysis, consumerPath, ctx);

      assert.ok(rewrites.size > 0);
      assert.ok(ctx.tracker.has(barrelPath));
    });

    it("handles re-exports", async () => {
      const ctx = createTestContext();
      const barrelPath = join(starBarrelDir, "index.ts");
      const consumerPath = join(starBarrelDir, "reexport.ts");

      const analysis = await analyzeFile(consumerPath, ctx);
      debug("Re-export analysis isBarrel:", analysis.isBarrel);
      debug("Re-export analysis imports:", [...analysis.imports.entries()]);

      const rewrites = await buildRewrites(analysis, consumerPath, ctx);
      debug("Re-export rewrites size:", rewrites.size);
      debug("Re-export ctx.tracker.barrels:", [...ctx.tracker.barrels.keys()]);

      assert.ok(rewrites.size > 0);
      assert.ok(ctx.tracker.has(barrelPath));
    });

    it("builds rewrites for namespace import from single-source barrel", async () => {
      const ctx = createTestContext();
      const barrelPath = join(starBarrelDir, "index.ts");
      const consumerPath = join(starBarrelDir, "namespace.ts");

      const analysis = await analyzeFile(consumerPath, ctx);

      const rewrites = await buildRewrites(analysis, consumerPath, ctx);

      assert.ok(rewrites.size > 0);
      assert.ok(ctx.tracker.has(barrelPath));
    });

    it("does not build rewrites for namespace import from multi-source barrel", async () => {
      const dir = fixture("rewrites-namespace-multi-source");
      const ctx = createTestContext();
      const barrelPath = join(dir, "index.ts");
      const consumerPath = join(dir, "consumer.ts");

      const analysis = await analyzeFile(consumerPath, ctx);

      const rewrites = await buildRewrites(analysis, consumerPath, ctx);

      assert.equal(rewrites.size, 0);
      assert.ok(ctx.tracker.has(barrelPath));
    });

    it("does not rewrite to files that export nothing via star re-export", async () => {
      const dir = fixture("rewrites-type-star-empty");
      const ctx = createTestContext();
      const consumerPath = join(dir, "consumer.ts");

      const analysis = await analyzeFile(consumerPath, ctx);

      const rewrites = await buildRewrites(analysis, consumerPath, ctx);

      assert.equal(rewrites.size, 1);
      const posRewrites = [...rewrites.values()][0];
      assert.equal(posRewrites.size, 1);
      const [targetPath] = [...posRewrites.keys()];
      assert.ok(targetPath.endsWith("context.ts"));
    });
  });
});
