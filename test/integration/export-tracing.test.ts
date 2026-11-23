import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { unbarrelify } from "../../src/main.ts";
import { copyFixture, read } from "../helpers.ts";

interface Expected {
  consumer?: string;
  rewritten: string[];
  deleted: string[];
  untraceable?: string[];
}

const cases: Record<string, Expected> = {
  "local-destructured-export": {
    rewritten: ['import { url, first } from "./local.mjs";'],
    deleted: ["index.mjs"],
  },
  "type-alias-keeps-type": {
    consumer: "consumer.ts",
    rewritten: [
      'import type { Original as Token } from "./types.ts";',
      'import type { Original as Fallback } from "./types.ts";',
    ],
    deleted: ["barrel.ts"],
  },
  "namespace-clause-member": {
    rewritten: ['import { sep } from "node:path";'],
    deleted: ["index.mjs"],
  },
  "package-named-then-star": {
    rewritten: ['import { sep } from "node:path";'],
    deleted: ["index.mjs"],
  },
  "package-star-then-named": {
    rewritten: ['import { basename } from "./index.mjs";'],
    deleted: [],
    untraceable: ["basename"],
  },
  "package-named-alias": {
    rewritten: ['import { basename as fn } from "node:path";'],
    deleted: ["index.mjs"],
  },
  "package-namespace-then-named": {
    rewritten: ['import { sep } from "node:path";'],
    deleted: ["index.mjs"],
  },
  "package-named-then-namespace": {
    rewritten: ['import { sep } from "./index.mjs";'],
    deleted: [],
    untraceable: ["sep"],
  },
  "aliased-local-star": {
    consumer: "consumer.ts",
    rewritten: ['import { sep } from "node:path";'],
    deleted: ["index.ts"],
  },
};

for (const [name, expected] of Object.entries(cases)) {
  test(`export tracing: ${name}`, async (t) => {
    const cwd = join(await copyFixture(t, "export-tracing"), name);
    const result = await unbarrelify({ cwd, write: true });

    const consumer = await read(join(cwd, expected.consumer ?? "consumer.mjs"));
    assert.deepEqual(consumer.split("\n").slice(0, expected.rewritten.length), expected.rewritten);
    assert.deepEqual(
      result.deleted,
      expected.deleted.map((file) => join(cwd, file)),
    );
    assert.deepEqual(
      result.untraceableImports.map((item) => item.name),
      expected.untraceable ?? [],
    );
  });
}
