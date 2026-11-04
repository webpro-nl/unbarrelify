import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { BarrelTracker, isWithinDirectory } from "../../src/tracker.ts";
import type { Context, File } from "../../src/types.ts";

function createTestContext(base: string, tracker: BarrelTracker): Context {
  return {
    base,
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
    tracker,
  };
}

function registerRewrittenBarrel(tracker: BarrelTracker, barrelPath: string, consumerPath: string): void {
  tracker.register(barrelPath);
  tracker.addConsumer(barrelPath, consumerPath);
  tracker.markRewritten(barrelPath, consumerPath);
}

describe("BarrelTracker", () => {
  describe("classify", () => {
    it("only classifies barrels inside the base directory", () => {
      const tracker = new BarrelTracker();
      const consumer = "/project/app/consumer.ts";
      const insideBarrel = "/project/app/inner/index.ts";
      const outsideBarrel = "/project/lib/index.ts";
      const siblingPrefixBarrel = "/project/app-shared/internal/index.ts";

      registerRewrittenBarrel(tracker, insideBarrel, consumer);
      registerRewrittenBarrel(tracker, outsideBarrel, consumer);
      registerRewrittenBarrel(tracker, siblingPrefixBarrel, consumer);

      const { deleted, preserved } = tracker.classify(createTestContext("/project/app", tracker));

      assert.deepEqual(deleted, [insideBarrel]);
      assert.deepEqual(preserved, []);
    });

    it("classifies barrels when the base is the filesystem root", () => {
      const tracker = new BarrelTracker();
      const barrel = "/project/inner/index.ts";
      registerRewrittenBarrel(tracker, barrel, "/project/consumer.ts");

      const { deleted } = tracker.classify(createTestContext("/", tracker));

      assert.deepEqual(deleted, [barrel]);
    });

    it("classifies barrels when the base has a trailing separator", () => {
      const tracker = new BarrelTracker();
      const consumer = "/project/app/consumer.ts";
      const insideBarrel = "/project/app/inner/index.ts";
      registerRewrittenBarrel(tracker, insideBarrel, consumer);
      registerRewrittenBarrel(tracker, "/project/app-shared/internal/index.ts", consumer);

      const { deleted } = tracker.classify(createTestContext("/project/app/", tracker));

      assert.deepEqual(deleted, [insideBarrel]);
    });
  });

  describe("isWithinDirectory", () => {
    it("respects directory boundaries on POSIX paths", () => {
      const { posix } = path;
      assert.equal(isWithinDirectory("/project/app/inner/index.ts", "/project/app", posix), true);
      assert.equal(isWithinDirectory("/project/app/..cache/index.ts", "/project/app", posix), true);
      assert.equal(isWithinDirectory("/project/app-shared/index.ts", "/project/app", posix), false);
      assert.equal(isWithinDirectory("/project/lib/index.ts", "/project/app", posix), false);
      assert.equal(isWithinDirectory("/project/app", "/project/app", posix), false);
      assert.equal(isWithinDirectory("/project/app/inner/index.ts", "/project/app/", posix), true);
      assert.equal(isWithinDirectory("/project/app-shared/index.ts", "/project/app/", posix), false);
      assert.equal(isWithinDirectory("/project/index.ts", "/", posix), true);
    });

    it("respects directory boundaries on Windows paths", () => {
      const { win32 } = path;
      assert.equal(isWithinDirectory("C:\\project\\app\\inner\\index.ts", "C:\\project\\app", win32), true);
      assert.equal(isWithinDirectory("C:/project/app/inner/index.ts", "C:/project/app", win32), true);
      assert.equal(isWithinDirectory("C:\\project\\app-shared\\index.ts", "C:\\project\\app", win32), false);
      assert.equal(isWithinDirectory("C:/project/app-shared/index.ts", "C:\\project\\app", win32), false);
      assert.equal(isWithinDirectory("D:\\project\\app\\inner\\index.ts", "C:\\project\\app", win32), false);
      assert.equal(isWithinDirectory("C:\\project\\app\\inner\\index.ts", "C:\\project\\app\\", win32), true);
      assert.equal(isWithinDirectory("C:\\project\\index.ts", "C:\\", win32), true);
    });

    it("does not admit path spellings rejected by the original prefix check", () => {
      const { win32 } = path;
      assert.equal(isWithinDirectory("C:/project/app/index.ts", "C:\\project\\app", win32), false);
      assert.equal(isWithinDirectory("C:\\PROJECT\\app\\index.ts", "C:\\project\\app", win32), false);
    });
  });
});
