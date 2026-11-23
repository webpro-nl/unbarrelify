import { test } from "node:test";
import assert from "node:assert/strict";
import { join, relative } from "node:path";
import { initProjectConfig, tryMapToAlias } from "../../src/config.ts";
import type { PathAliases } from "../../src/types.ts";

const fixturesDir = join(process.cwd(), "fixtures");

test("initProjectConfig: loads files from tsconfig include", () => {
  const config = initProjectConfig(join(fixturesDir, "namespace-import"));
  assert.ok(config.files.length >= 2);
  assert.ok(config.files.some((f) => f.endsWith("consumer.ts")));
});

test("initProjectConfig: loads files from nested project references", () => {
  const fixtureDir = join(fixturesDir, "project-references");
  const config = initProjectConfig(fixtureDir);

  assert.deepEqual(config.files.map((file) => relative(fixtureDir, file)).sort(), [
    "packages/app/src/consumer.ts",
    "packages/app/src/index.ts",
    "packages/app/src/value.ts",
  ]);
  assert.deepEqual(
    config.explicitFiles.map((file) => relative(fixtureDir, file)),
    ["packages/app/src/index.ts"],
  );
});

test("initProjectConfig: isPackageEntryPoint returns true for package.json#exports", () => {
  const config = initProjectConfig(join(fixturesDir, "public-export"));
  const indexPath = join(fixturesDir, "public-export/src/index.ts");
  assert.ok(config.isPackageEntryPoint(indexPath));
});

test("initProjectConfig: isPackageEntryPoint returns true for nested workspace packages", () => {
  const config = initProjectConfig(join(fixturesDir, "package-entry-point"));
  const iconsIndexPath = join(fixturesDir, "package-entry-point/packages/icons/gen/index.ts");
  const iconsUtilsPath = join(fixturesDir, "package-entry-point/packages/icons/gen/utils.ts");
  const iconsInfoPath = join(fixturesDir, "package-entry-point/packages/icons/src/info.ts");
  assert.ok(config.isPackageEntryPoint(iconsIndexPath));
  assert.ok(config.isPackageEntryPoint(iconsUtilsPath));
  assert.ok(config.isPackageEntryPoint(iconsInfoPath));
});

test("tryMapToAlias: returns null for relative specifiers", () => {
  const aliases: PathAliases = {
    baseUrl: "/project",
    paths: { "@/*": ["src/*"] },
  };
  const result = tryMapToAlias("/project/src/utils.ts", aliases, "./utils");
  assert.equal(result, null);
});

test("tryMapToAlias: returns null for absolute specifiers", () => {
  const aliases: PathAliases = {
    baseUrl: "/project",
    paths: { "@/*": ["src/*"] },
  };
  const result = tryMapToAlias("/project/src/utils.ts", aliases, "/absolute/path");
  assert.equal(result, null);
});

test("tryMapToAlias: maps path to alias when original used alias", () => {
  const aliases: PathAliases = {
    baseUrl: "/project",
    paths: { "@/*": ["src/*"] },
  };
  const result = tryMapToAlias("/project/src/utils.ts", aliases, "@/barrel");
  assert.equal(result, "@/utils");
});

test("tryMapToAlias: handles nested paths", () => {
  const aliases: PathAliases = {
    baseUrl: "/project",
    paths: { "@/*": ["src/*"] },
  };
  const result = tryMapToAlias("/project/src/components/Button.tsx", aliases, "@/index");
  assert.equal(result, "@/components/Button");
});

test("tryMapToAlias: handles multiple alias patterns", () => {
  const aliases: PathAliases = {
    baseUrl: "/project",
    paths: {
      "@/*": ["src/*"],
      "@utils/*": ["src/utils/*"],
    },
  };
  const result = tryMapToAlias("/project/src/utils/helpers.ts", aliases, "@utils/index");
  assert.equal(result, "@utils/helpers");
});

test("tryMapToAlias: matches alias keys literally", () => {
  const aliases: PathAliases = {
    baseUrl: "/project",
    paths: { "@literal/[": ["src/decoy.ts"], "@lib/*": ["src/*"], "@a.b/*": ["other/*"] },
  };
  assert.equal(tryMapToAlias("/project/src/leaf.ts", aliases, "@lib/barrel.js"), "@lib/leaf");
  assert.equal(tryMapToAlias("/project/other/leaf.ts", aliases, "@axb/barrel"), null);
});

test("tryMapToAlias: returns null when path doesn't match alias target", () => {
  const aliases: PathAliases = {
    baseUrl: "/project",
    paths: { "@/*": ["src/*"] },
  };
  const result = tryMapToAlias("/other/path/file.ts", aliases, "@/barrel");
  assert.equal(result, null);
});

test("tryMapToAlias: strips file extension from result", () => {
  const aliases: PathAliases = {
    baseUrl: "/project",
    paths: { "@/*": ["src/*"] },
  };
  const result = tryMapToAlias("/project/src/utils.ts", aliases, "@/barrel");
  assert.ok(!result?.endsWith(".ts"));
  assert.equal(result, "@/utils");
});
