import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { unbarrelify } from "../../src/main.ts";
import { copyFixture, read } from "../helpers.ts";

interface Expected {
  consumer?: string;
  unsafeNamespace?: boolean;
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
    rewritten: ['import { sep } from "node:path";'],
    deleted: ["index.mjs"],
  },
  "aliased-local-star": {
    consumer: "consumer.ts",
    rewritten: ['import { sep } from "node:path";'],
    deleted: ["index.ts"],
  },
  "named-through-package-star": {
    rewritten: ['import { sep } from "node:path";'],
    deleted: ["index.mjs", "proxy.mjs"],
  },
  "named-through-two-package-stars": {
    rewritten: ['import { sep } from "./index.mjs";'],
    deleted: [],
    untraceable: ["sep"],
  },
  "named-beside-package-star": {
    rewritten: ['import { sep } from "node:path";'],
    deleted: ["index.mjs", "named.mjs", "proxy.mjs"],
  },
  "renamed-through-package-star": {
    rewritten: ['import { sep as separator } from "node:path";'],
    deleted: ["index.mjs", "named.mjs", "proxy.mjs"],
  },
  "named-cycle-shadowed-star": {
    rewritten: ['import { foo } from "./leaf.mjs";'],
    deleted: [],
  },
  "unresolved-named-beside-package-star": {
    rewritten: ['import { sep } from "./index.mjs";'],
    deleted: [],
    untraceable: ["sep"],
  },
  "named-to-ignored-target": {
    rewritten: ['import { value } from "./index.mjs";'],
    deleted: [],
    untraceable: ["value"],
  },
  "namespace-and-named-local": {
    rewritten: ['import { sep } from "node:path";', 'import { other } from "./local.mjs";'],
    deleted: ["index.mjs"],
  },
  "namespace-from-mixed-record": {
    rewritten: ['import * as p from "node:path";'],
    deleted: ["index.mjs"],
  },
  "namespace-and-named-one-import": {
    rewritten: ['import { p, sep } from "./index.mjs";'],
    deleted: [],
    untraceable: ["sep"],
  },
  "namespace-over-star": {
    rewritten: ['import * as tools from "./tools.mjs";'],
    deleted: ["index.mjs"],
  },
  "namespace-renamed-by-consumer": {
    rewritten: ['import * as mine from "./tools.mjs";'],
    deleted: ["index.mjs"],
  },
  "type-default-alias": {
    consumer: "consumer.ts",
    rewritten: ['import type { default as Token } from "./types.ts";'],
    deleted: ["barrel.ts"],
  },
  "type-default-import": {
    consumer: "consumer.ts",
    rewritten: ['import type { default as Token } from "./types.ts";'],
    deleted: ["barrel.ts"],
  },
  "two-namespaces-one-package": {
    rewritten: ['import * as paths from "node:path";', 'import * as pathTools from "node:path";'],
    deleted: ["index.mjs"],
  },
  "namespace-named-like-alias-source": {
    rewritten: ['import { sep as separator } from "node:path";'],
    deleted: ["index.mjs"],
  },
  "local-namespace-named-like-alias-source": {
    rewritten: ['import { v as value } from "./x.mjs";'],
    deleted: ["index.mjs"],
  },
  "private-key-star-consumer": {
    consumer: "entry.mjs",
    rewritten: ["export const marker = 42;", 'export * from "./leaf.js";'],
    deleted: ["barrel.js"],
  },
  "private-key-unsafe-namespace": {
    unsafeNamespace: true,
    rewritten: ['import { value } from "./leaf.js";', 'import { id } from "./two.js";'],
    deleted: ["barrel.js"],
  },
  "private-key-unsafe-namespace-barrel": {
    unsafeNamespace: true,
    rewritten: ['import * as ns from "#barrel";'],
    deleted: [],
  },
  "unsafe-namespace-ignored-targets": {
    unsafeNamespace: true,
    rewritten: ['import * as ns from "./barrel.mjs";'],
    deleted: [],
  },
  "private-key-named-dependency": {
    rewritten: ['import { sep } from "./barrel.mjs";'],
    deleted: [],
    untraceable: ["sep"],
  },
  "private-key-star-dependency": {
    rewritten: ['import { sep } from "./barrel.mjs";'],
    deleted: [],
    untraceable: ["sep"],
  },
  "private-key-star-dependency-flattened": {
    consumer: "entry.mjs",
    rewritten: ["export const marker = 42;", 'export * from "./barrel.mjs";'],
    deleted: [],
  },
  "private-key-star-dependency-alone": {
    rewritten: ['import { sep } from "./barrel.mjs";'],
    deleted: [],
    untraceable: ["sep"],
  },
  "bare-star-other-package": {
    consumer: "app/consumer.mjs",
    rewritten: ['import { value } from "../producer/real.mjs";'],
    deleted: ["producer/barrel.mjs"],
  },
  "bare-star-same-package": {
    rewritten: ['import { value } from "shared-kit/leaf";'],
    deleted: ["barrel.mjs"],
  },
  "bare-star-of-stars-other-package": {
    consumer: "app/consumer.mjs",
    rewritten: ['import { value } from "../producer/inner.mjs";'],
    deleted: ["producer/barrel.mjs"],
  },
  "private-key-with-query": {
    rewritten: ['import { value } from "./right.mjs";'],
    deleted: ["special.mjs"],
  },
  "private-key-with-fragment": {
    rewritten: ['import { value } from "./right.mjs";'],
    deleted: ["special.mjs"],
  },
  "private-key-with-query-dynamic": {
    consumer: "static.mjs",
    rewritten: ['import { value } from "./right.mjs";'],
    deleted: [],
  },
  "private-key-with-query-conditional": {
    rewritten: ['import { value } from "./right.mjs";'],
    deleted: ["special.mjs"],
  },
  "private-key-with-query-reexport": {
    rewritten: ['export { value } from "./right.mjs";'],
    deleted: ["special.mjs"],
  },
  "private-key-with-query-vue": {
    consumer: "static.mjs",
    rewritten: ['import { value } from "./right.mjs";'],
    deleted: [],
  },
  "private-key-conditional-target": {
    rewritten: ['import { value } from "./leaf.mjs";'],
    deleted: ["barrel.mjs"],
  },
  "private-key-with-query-array": {
    rewritten: ['import { value } from "./right.mjs";'],
    deleted: ["special.mjs"],
  },
  "private-key-with-query-pattern": {
    rewritten: ['import { value } from "./right.mjs";'],
    deleted: ["special-mode.mjs"],
  },
  "private-key-with-query-declaration": {
    rewritten: ['import { value } from "./right.mjs";'],
    deleted: ["special.mjs"],
  },
  "bare-star-shadowed-by-paths": {
    consumer: "app/consumer.mjs",
    rewritten: ['import { value } from "../producer/real.mjs";'],
    deleted: ["producer/barrel.mjs"],
  },
  "aliased-local-star-name": {
    consumer: "consumer.ts",
    rewritten: ['import { first } from "@lib/names.ts";'],
    deleted: ["index.ts"],
  },
  "private-key-with-query-source-beside": {
    rewritten: ['import { value } from "./right.mjs";'],
    deleted: ["selected.mjs"],
  },
  "private-key-with-query-types-condition": {
    rewritten: ['import { value } from "./right.mjs";'],
    deleted: ["selected.mjs"],
  },
  "bare-star-absent-in-consumer": {
    consumer: "app/consumer.mjs",
    rewritten: ['import { value } from "../producer/real.mjs";'],
    deleted: ["producer/barrel.mjs"],
  },
  "private-key-with-query-patterns": {
    rewritten: ['import { value } from "./right.mjs";'],
    deleted: ["special-d.mjs"],
  },
  "private-key-with-query-dependency": {
    rewritten: ['import { sep } from "#lib?mode";'],
    deleted: [],
  },
  "private-key-with-query-array-invalid": {
    consumer: "app/consumer.mjs",
    rewritten: ['import { value } from "./right.mjs";'],
    deleted: ["app/selected.mjs"],
  },
  "private-key-with-query-module-sync": {
    rewritten: ['import { value } from "./right.mjs";'],
    deleted: ["special.mjs"],
  },
  "private-key-with-query-node-addons": {
    rewritten: ['import { value } from "./right.mjs";'],
    deleted: ["special.mjs"],
  },
  "private-key-with-query-require-first-vue": {
    consumer: "static.mjs",
    rewritten: ['import { value } from "./right.mjs";'],
    deleted: [],
  },
  "private-key-with-query-reused": {
    rewritten: ['import { n } from "#inner?flavor";'],
    deleted: ["nested/barrel.ts"],
  },
  "private-key-with-query-reused-elsewhere": {
    rewritten: ['import { n } from "#outer";'],
    deleted: [],
    untraceable: ["n"],
  },
  "private-key-with-query-reused-blocked": {
    rewritten: ['import { n } from "#outer";'],
    deleted: [],
    untraceable: ["n"],
  },
  "private-key-with-query-reused-null-array": {
    rewritten: ['import { n } from "#inner?flavor";'],
    deleted: ["nested/barrel.ts"],
  },
  "type-namespace-alias": {
    consumer: "consumer.ts",
    rewritten: ['import type * as B from "./leaf.ts";'],
    deleted: ["barrel.ts"],
  },
  "type-namespace-import": {
    consumer: "consumer.ts",
    rewritten: ['import type * as NS from "./leaf.ts";'],
    deleted: ["barrel.ts"],
  },
  "private-key-generated-require-first": {
    rewritten: ['import { value } from "./vendor/good.mjs";'],
    deleted: ["vendor/barrel.mjs"],
  },
};

for (const [name, expected] of Object.entries(cases)) {
  test(`export tracing: ${name}`, async (t) => {
    const cwd = join(await copyFixture(t, "export-tracing"), name);
    const result = await unbarrelify({ cwd, write: true, unsafeNamespace: expected.unsafeNamespace });

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
