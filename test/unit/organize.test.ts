import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { organizeImports } from "../../src/organize.ts";

describe("organizeImports", () => {
  test("keeps compiler suppression directives attached to their imports", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "unbarrelify-import-directives-"));
    t.after(() => rm(dir, { recursive: true }));
    const file = join(dir, "consumer.ts");
    const content = `// @ts-expect-error This JavaScript module has no declarations.
import { foo } from "./legacy.js";
// @ts-expect-error This JavaScript module has no declarations.
import { bar } from "./legacy.js";
console.log(foo, bar);
`;
    await writeFile(join(dir, "legacy.js"), "export const foo = 1, bar = 2;\n");
    await writeFile(file, content);
    const diagnostics = () =>
      ts
        .getPreEmitDiagnostics(
          ts.createProgram([file], {
            strict: true,
            noEmit: true,
            allowJs: false,
            types: [],
            module: ts.ModuleKind.ESNext,
            moduleResolution: ts.ModuleResolutionKind.Bundler,
          }),
        )
        .map((diagnostic) => ({
          code: diagnostic.code,
          message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
        }));

    assert.deepEqual(diagnostics(), []);
    await writeFile(file, organizeImports(content, file));
    assert.deepEqual(diagnostics(), []);
  });

  test("preserves an exported declaration between duplicate imports", () => {
    const content = `import { foo } from "./value.ts";
export const saved = foo;
import { bar } from "./value.ts";
console.log(saved, bar);
`;

    const result = organizeImports(content, "consumer.ts");

    assert.ok(result.includes("export const saved = foo;"), "the interleaved export must survive");
    assert.ok(result.includes("console.log(saved, bar);"));
  });

  test("merges adjacent imports from the same module", () => {
    const result = organizeImports(
      'import { foo } from "./value.ts";\nimport { bar } from "./value.ts";\nfoo(bar);\n',
      "consumer.ts",
    );

    assert.equal((result.match(/from "\.\/value\.ts"/g) || []).length, 1);
    assert.ok(result.includes('import { bar, foo } from "./value.ts";'));
    assert.ok(result.endsWith("foo(bar);\n"));
  });

  test("leaves content without duplicate imports byte for byte unchanged", () => {
    const content = `#!/usr/bin/env node\r\n"use client";\r\n// Header\r\nimport { foo } from './foo.ts';\r\nexport const saved = foo;\r\nimport './effect.ts';\r\n`;

    assert.equal(organizeImports(content, "consumer.ts"), content);
  });

  test("keeps import groups separate across statements", () => {
    const content = `import { foo } from "./value.ts";
import { a } from "./other.ts";
export const saved = foo;
import "./effect.ts";
function sum() { return a + b; }
import { bar } from "./value.ts";
console.log(saved, bar, sum());
import { b } from "./other.ts";
`;

    const result = organizeImports(content, "consumer.ts");

    assert.equal(result, content);
  });

  test("keeps variable declarations separate from array expressions across imports", () => {
    const content = `import { foo } from "./value.ts";
const saved = foo
import { bar } from "./value.ts";
[bar].forEach(console.log);
`;
    assert.equal(organizeImports(content, "consumer.ts"), content);
  });

  test("preserves type-only imports when coalescing returns multiple declarations", () => {
    const content = `import { foo } from "./value.ts";
import type { Value } from "./value.ts";
const saved: Value = foo;
`;
    const result = organizeImports(content, "consumer.ts");
    const parsed = ts.createSourceFile("consumer.ts", result, ts.ScriptTarget.Latest, true);
    const imports = parsed.statements.filter(ts.isImportDeclaration);
    assert.equal(imports.length, 2);
    assert.deepEqual(
      imports.map((imp) => imp.importClause?.isTypeOnly),
      [false, true],
    );
    assert.ok(result.includes("const saved: Value = foo;"));
  });

  test("keeps ts-ignore directives attached to their imports", () => {
    const content = `// @ts-ignore The dependency has no types.
import { foo } from "./legacy.js";
// @ts-ignore The dependency has no types.
import { bar } from "./legacy.js";
console.log(foo, bar);
`;
    assert.equal(organizeImports(content, "consumer.ts"), content);
  });

  for (const prefix of ["#!/usr/bin/env node\n", '#!/usr/bin/env node\n"use client";\n']) {
    test(`preserves the prologue ${JSON.stringify(prefix)}`, () => {
      const content = `${prefix}// License header
import { foo } from "./value.ts";
import { bar } from "./value.ts";
console.log(foo, bar);
`;

      const result = organizeImports(content, "consumer.ts");

      assert.ok(result.startsWith(`${prefix}// License header\n`));
      assert.equal((result.match(/License header/g) || []).length, 1);
      assert.equal((result.match(/from "\.\/value\.ts"/g) || []).length, 1);
    });
  }

  test("preserves comments around imports and interleaved statements exactly once", () => {
    const content = `// Header
import { foo } from "./value.ts"; // First import
// Public export
export const saved = foo;
/* Second import */
import { /* Named binding */ bar } from "./value.ts"; // Last import
// Consumer
console.log(saved, bar);
`;

    const result = organizeImports(content, "consumer.ts");

    for (const comment of [
      "// Header",
      "// First import",
      "// Public export",
      "/* Second import */",
      "/* Named binding */",
      "// Last import",
      "// Consumer",
    ]) {
      assert.equal(result.split(comment).length - 1, 1, comment);
    }
    assert.ok(result.includes("// Public export\nexport const saved = foo;"));
    assert.ok(result.includes("// Consumer\nconsole.log(saved, bar);"));
  });
});
