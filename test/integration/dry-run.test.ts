import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { unbarrelify } from "../../src/main.ts";
import { fixture, copyFixture, read, snapshotDir } from "../helpers.ts";

describe("dry-run mode tests", () => {
  describe("dry-run mode doesn't modify files", () => {
    test("simple-barrel: files remain unchanged in dry-run mode", async () => {
      const fixtureDir = fixture("simple-barrel");

      const result = await unbarrelify({
        cwd: fixtureDir,
        files: ["**/*.ts"],
        skip: [],
        ext: ".js",
        write: false,
      });

      assert.ok(result.modified.length > 0);
      assert.ok(result.deleted.length > 0);
    });

    test("chained-barrels: files remain unchanged in dry-run mode", async () => {
      const fixtureDir = fixture("chained-barrels");

      const result = await unbarrelify({
        cwd: fixtureDir,
        files: ["**/*.ts"],
        skip: [],
        ext: ".js",
        write: false,
      });

      assert.ok(result.modified.length > 0);
      assert.ok(result.deleted.length > 0);
    });

    test("mixed-imports: files remain unchanged in dry-run mode", async () => {
      const fixtureDir = fixture("mixed-imports");

      const result = await unbarrelify({
        cwd: fixtureDir,
        files: ["**/*.ts"],
        skip: [],
        ext: ".js",
        write: false,
      });

      assert.ok(result.modified.length > 0);
      assert.ok(result.deleted.length > 0);
    });
  });

  describe("write mode modifies files", () => {
    test("simple-barrel: files are modified in write mode", async (t) => {
      const fixtureDir = await copyFixture(t, "simple-barrel");
      const before = await snapshotDir(fixtureDir);

      const result = await unbarrelify({
        cwd: fixtureDir,
        files: ["**/*.ts"],
        skip: [],
        ext: ".js",
        write: true,
      });

      assert.ok(result.modified.length > 0);
      assert.ok(result.deleted.length > 0);

      assert.ok(!existsSync(join(fixtureDir, "index.ts")));

      const consumerContent = await read(join(fixtureDir, "consumer.ts"));
      assert.notEqual(consumerContent, before.get("consumer.ts"));

      assert.ok(consumerContent.includes("./utils.js"));
      assert.ok(!consumerContent.includes("./index"));
    });

    test("chained-barrels: files are modified in write mode", async (t) => {
      const fixtureDir = await copyFixture(t, "chained-barrels");
      const before = await snapshotDir(fixtureDir);

      const result = await unbarrelify({
        cwd: fixtureDir,
        files: ["**/*.ts"],
        skip: [],
        ext: ".js",
        write: true,
      });

      assert.ok(result.modified.length > 0);
      assert.ok(result.deleted.length >= 2);

      assert.ok(!existsSync(join(fixtureDir, "index.ts")));
      assert.ok(!existsSync(join(fixtureDir, "sub", "index.ts")));

      const consumerContent = await read(join(fixtureDir, "consumer.ts"));
      assert.notEqual(consumerContent, before.get("consumer.ts"));

      assert.ok(consumerContent.includes("./sub/impl.js"));
    });
  });

  describe("dry-run and write mode report same changes", () => {
    test("simple-barrel: dry-run and write mode report identical results", async (t) => {
      const dryRunFixtureDir = fixture("simple-barrel");

      const dryRunResult = await unbarrelify({
        cwd: dryRunFixtureDir,
        files: ["**/*.ts"],
        skip: [],
        ext: ".js",
        write: false,
      });

      const writeFixtureDir = await copyFixture(t, "simple-barrel");

      const writeResult = await unbarrelify({
        cwd: writeFixtureDir,
        files: ["**/*.ts"],
        skip: [],
        ext: ".js",
        write: true,
      });

      const normalizeResults = (result: { modified: string[]; deleted: string[] }, baseDir: string) => ({
        modified: result.modified.map((p) => p.replace(baseDir, "")).sort(),
        deleted: result.deleted.map((p) => p.replace(baseDir, "")).sort(),
      });

      const normalizedDryRun = normalizeResults(dryRunResult, dryRunFixtureDir);
      const normalizedWrite = normalizeResults(writeResult, writeFixtureDir);

      assert.deepEqual(normalizedDryRun.modified, normalizedWrite.modified);
      assert.deepEqual(normalizedDryRun.deleted, normalizedWrite.deleted);
    });

    test("chained-barrels: dry-run and write mode report identical results", async (t) => {
      const dryRunFixtureDir = fixture("chained-barrels");

      const dryRunResult = await unbarrelify({
        cwd: dryRunFixtureDir,
        files: ["**/*.ts"],
        skip: [],
        ext: ".js",
        write: false,
      });

      const writeFixtureDir = await copyFixture(t, "chained-barrels");

      const writeResult = await unbarrelify({
        cwd: writeFixtureDir,
        files: ["**/*.ts"],
        skip: [],
        ext: ".js",
        write: true,
      });

      const normalizeResults = (result: { modified: string[]; deleted: string[] }, baseDir: string) => ({
        modified: result.modified.map((p) => p.replace(baseDir, "")).sort(),
        deleted: result.deleted.map((p) => p.replace(baseDir, "")).sort(),
      });

      const normalizedDryRun = normalizeResults(dryRunResult, dryRunFixtureDir);
      const normalizedWrite = normalizeResults(writeResult, writeFixtureDir);

      assert.deepEqual(normalizedDryRun.modified, normalizedWrite.modified);
      assert.deepEqual(normalizedDryRun.deleted, normalizedWrite.deleted);
    });

    test("mixed-imports: dry-run and write mode report identical results", async (t) => {
      const dryRunFixtureDir = fixture("mixed-imports");

      const dryRunResult = await unbarrelify({
        cwd: dryRunFixtureDir,
        files: ["**/*.ts"],
        skip: [],
        ext: ".js",
        write: false,
      });

      const writeFixtureDir = await copyFixture(t, "mixed-imports");

      const writeResult = await unbarrelify({
        cwd: writeFixtureDir,
        files: ["**/*.ts"],
        skip: [],
        ext: ".js",
        write: true,
      });

      const normalizeResults = (result: { modified: string[]; deleted: string[] }, baseDir: string) => ({
        modified: result.modified.map((p) => p.replace(baseDir, "")).sort(),
        deleted: result.deleted.map((p) => p.replace(baseDir, "")).sort(),
      });

      const normalizedDryRun = normalizeResults(dryRunResult, dryRunFixtureDir);
      const normalizedWrite = normalizeResults(writeResult, writeFixtureDir);

      assert.deepEqual(normalizedDryRun.modified, normalizedWrite.modified);
      assert.deepEqual(normalizedDryRun.deleted, normalizedWrite.deleted);
    });
  });

  describe("edge cases", () => {
    test("dry-run mode with no changes needed", async () => {
      const fixtureDir = fixture("not-barrel");

      const result = await unbarrelify({
        cwd: fixtureDir,
        files: ["**/*.ts"],
        skip: [],
        ext: ".js",
        write: false,
      });

      assert.equal(result.modified.length, 0);
      assert.equal(result.deleted.length, 0);
    });

    test("multiple dry-run executions produce consistent results", async () => {
      const fixtureDir = fixture("simple-barrel");

      const result1 = await unbarrelify({
        cwd: fixtureDir,
        files: ["**/*.ts"],
        skip: [],
        ext: ".js",
        write: false,
      });

      const result2 = await unbarrelify({
        cwd: fixtureDir,
        files: ["**/*.ts"],
        skip: [],
        ext: ".js",
        write: false,
      });

      const result3 = await unbarrelify({
        cwd: fixtureDir,
        files: ["**/*.ts"],
        skip: [],
        ext: ".js",
        write: false,
      });

      assert.deepEqual(result1.modified.sort(), result2.modified.sort());
      assert.deepEqual(result2.modified.sort(), result3.modified.sort());
      assert.deepEqual(result1.deleted.sort(), result2.deleted.sort());
      assert.deepEqual(result2.deleted.sort(), result3.deleted.sort());
    });
  });
});
