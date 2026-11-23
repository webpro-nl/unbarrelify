import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { resolveModule, ensureExtension, buildSpecifier } from "../../src/resolver.ts";
import { initProjectConfig } from "../../src/config.ts";
import { join } from "node:path";
import { fixture } from "../helpers.ts";

describe("resolver", () => {
  describe("resolveModule", () => {
    test("resolves relative imports with extension", () => {
      const fromPath = join(process.cwd(), "src/main.ts");
      const result = resolveModule(fromPath, "./types.ts", null);
      assert.ok(result);
      assert.ok(result.endsWith("types.ts"));
    });

    test("resolves relative imports without extension", () => {
      const fromPath = join(process.cwd(), "src/main.ts");
      const result = resolveModule(fromPath, "./types", null);
      assert.ok(result);
      assert.ok(result.endsWith("types.ts"));
    });

    test("preserves node_modules package specifier", () => {
      const fromPath = join(process.cwd(), "src/main.ts");
      const result = resolveModule(fromPath, "typescript", null);
      assert.equal(result, "typescript");
    });

    test("preserves scoped package specifier", () => {
      const fromPath = join(process.cwd(), "src/main.ts");
      const result = resolveModule(fromPath, "oxc-resolver", null);
      assert.equal(result, "oxc-resolver");
    });

    test("resolves path aliases for non-TypeScript importers outside tsconfig include", () => {
      const fixturePath = join(process.cwd(), "fixtures/external-consumer");
      const result = resolveModule(join(fixturePath, "components/Image.astro"), "@fixture/errors", {
        baseUrl: fixturePath,
        configFile: join(fixturePath, "tsconfig.json"),
        paths: { "@fixture/*": ["./src/*"] },
      });

      assert.equal(result, join(fixturePath, "src/errors/index.ts"));
    });

    test("returns undefined for non-existent modules", () => {
      const fromPath = join(process.cwd(), "src/main.ts");
      const result = resolveModule(fromPath, "./non-existent-module", null);
      assert.equal(result, undefined);
    });
  });

  describe("ensureExtension", () => {
    test("replaces .ts with specified extension", () => {
      assert.equal(ensureExtension("file.ts", ".js"), "file.js");
    });

    test("replaces .tsx with specified extension", () => {
      assert.equal(ensureExtension("file.tsx", ".js"), "file.js");
    });

    test("replaces .js with specified extension", () => {
      assert.equal(ensureExtension("file.js", ".ts"), "file.ts");
    });

    test("replaces .jsx with specified extension", () => {
      assert.equal(ensureExtension("file.jsx", ".js"), "file.js");
    });

    test("preserves path without matching extension", () => {
      assert.equal(ensureExtension("file.json", ".js"), "file.json");
    });

    test("handles paths with directories", () => {
      assert.equal(ensureExtension("src/utils/helper.ts", ".js"), "src/utils/helper.js");
    });
  });

  describe("buildSpecifier", () => {
    test("generates relative path from same directory", () => {
      const result = buildSpecifier("/project/src/a.ts", "/project/src/b.ts", { ext: ".js" });
      assert.equal(result, "./b.js");
    });

    test("generates relative path from parent directory", () => {
      const result = buildSpecifier("/project/src/a.ts", "/project/src/utils/b.ts", { ext: ".js" });
      assert.equal(result, "./utils/b.js");
    });

    test("generates relative path from child directory", () => {
      const result = buildSpecifier("/project/src/utils/a.ts", "/project/src/b.ts", { ext: ".js" });
      assert.equal(result, "../b.js");
    });

    test("generates relative path across directories", () => {
      const result = buildSpecifier("/project/src/utils/a.ts", "/project/src/helpers/b.ts", { ext: ".js" });
      assert.equal(result, "../helpers/b.js");
    });

    test("applies extension transformation", () => {
      const result = buildSpecifier("/project/src/a.ts", "/project/src/b.tsx", { ext: ".js" });
      assert.equal(result, "./b.js");
    });

    test("keeps the target's own extension for TypeScript-style specifiers", () => {
      const options = { originalSpecifier: "./index.ts" };
      assert.equal(buildSpecifier("/project/src/a.ts", "/project/src/b.ts", options), "./b.ts");
      assert.equal(buildSpecifier("/project/src/a.ts", "/project/src/b.tsx", options), "./b.tsx");
      assert.equal(buildSpecifier("/project/src/a.ts", "/project/src/b.js", options), "./b.js");
      assert.equal(buildSpecifier("/project/src/a.ts", "/project/src/b.mts", options), "./b.mts");
      assert.equal(buildSpecifier("/project/src/a.ts", "/project/src/b.tsx", { ext: ".ts" }), "./b.tsx");
    });

    test("keeps the module format of the target for JavaScript-style specifiers", () => {
      const options = { originalSpecifier: "./index.js" };
      assert.equal(buildSpecifier("/project/src/a.ts", "/project/src/b.ts", options), "./b.js");
      assert.equal(buildSpecifier("/project/src/a.ts", "/project/src/b.mts", options), "./b.mjs");
      assert.equal(buildSpecifier("/project/src/a.ts", "/project/src/b.cts", options), "./b.cjs");
      assert.equal(buildSpecifier("/project/src/a.ts", "/project/src/b.mjs", options), "./b.mjs");
      assert.equal(buildSpecifier("/project/src/a.ts", "/project/src/b.cjs", options), "./b.cjs");
      assert.equal(buildSpecifier("/project/src/a.ts", "/project/src/b.mts", { ext: ".js" }), "./b.mjs");
    });

    test("keeps the module format of the target for extensionless specifiers", () => {
      const options = { originalSpecifier: "./index" };
      assert.equal(buildSpecifier("/project/src/a.ts", "/project/src/b.ts", options), "./b");
      assert.equal(buildSpecifier("/project/src/a.ts", "/project/src/b.mts", options), "./b.mjs");
      assert.equal(buildSpecifier("/project/src/a.ts", "/project/src/b.cts", options), "./b.cjs");
    });

    test("writes the output extension of the target for other JavaScript extensions", () => {
      const from = "/project/src/a.ts";
      assert.equal(buildSpecifier(from, "/project/src/b.ts", { originalSpecifier: "./index.mjs" }), "./b.js");
      assert.equal(buildSpecifier(from, "/project/src/b.tsx", { originalSpecifier: "./index.mjs" }), "./b.js");
      assert.equal(buildSpecifier(from, "/project/src/b.mts", { originalSpecifier: "./index.mjs" }), "./b.mjs");
      assert.equal(buildSpecifier(from, "/project/src/b.ts", { originalSpecifier: "./index.cjs" }), "./b.js");
      assert.equal(buildSpecifier(from, "/project/src/b.cts", { originalSpecifier: "./index.cjs" }), "./b.cjs");
      assert.equal(buildSpecifier(from, "/project/src/b.ts", { originalSpecifier: "./index.jsx" }), "./b.js");
      assert.equal(buildSpecifier(from, "/project/src/b.tsx", { originalSpecifier: "./index.jsx" }), "./b.jsx");
      assert.equal(buildSpecifier(from, "/project/src/b.ts", { ext: ".mjs" }), "./b.js");
    });

    test("applies the same extension rule to path aliases", () => {
      const dir = fixture("alias-extensions");
      const from = join(dir, "src/consumer.ts");
      const { aliases } = initProjectConfig(dir);
      const build = (originalSpecifier: string, target: string) =>
        buildSpecifier(from, join(dir, "src", target), { originalSpecifier, aliases });
      assert.equal(build("@/index", "value.ts"), "@/value");
      assert.equal(build("@/index", "tool.mts"), "@/tool.mjs");
      assert.equal(build("@/index.js", "value.ts"), "@/value.js");
      assert.equal(build("@/index.js", "tool.mts"), "@/tool.mjs");
      assert.equal(build("@/index.mjs", "value.ts"), "@/value.js");
      assert.equal(build("@/index.ts", "Button.tsx"), "@/Button.tsx");
    });

    test("keeps the extension of a wildcard package import key", () => {
      for (const [name, target] of [
        ["package-key-wildcard", "src/leaf.js"],
        ["package-key-wildcard-suffix", "src/leaf.ts"],
      ]) {
        const dir = fixture(name);
        const options = { originalSpecifier: "#lib/barrel.js" };
        assert.equal(buildSpecifier(join(dir, "consumer.mjs"), join(dir, target), options), "#lib/leaf.js", name);
      }
    });

    test("does not drop the extension of a wildcard alias that another alias shadows", () => {
      const dir = fixture("alias-shadowed-wildcard");
      const { aliases } = initProjectConfig(dir);
      const specifier = buildSpecifier(join(dir, "consumer.ts"), join(dir, "src/leaf.ts"), {
        originalSpecifier: "@lib/barrel.js",
        aliases,
      });
      assert.equal(specifier, "./src/leaf.js");
    });
  });
});
