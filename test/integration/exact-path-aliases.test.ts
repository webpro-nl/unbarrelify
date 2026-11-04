import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import { test, type TestContext } from "node:test";
import ts from "typescript";
import { initProjectConfig } from "../../src/config.ts";
import { unbarrelify } from "../../src/main.ts";
import { buildSpecifier } from "../../src/resolver.ts";

async function createProject(t: TestContext, paths: Record<string, string[]>, specifier: string) {
  const cwd = realpathSync(await mkdtemp(join(tmpdir(), "unbarrelify-exact-alias-")));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const files = {
    "package.json": JSON.stringify({ type: "module" }),
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        strict: true,
        noEmit: true,
        allowImportingTsExtensions: true,
        lib: ["ES2022"],
        skipLibCheck: true,
        types: [],
        paths,
      },
      include: ["**/*.ts"],
    }),
    "src/utils/value.ts": "export const value = 21;\n",
    "src/utils/index.ts": 'export { value } from "./value";\n',
    "consumer.ts": `import { value } from "${specifier}";\nexport const kept: number = value * 2;\n`,
  };
  for (const [name, content] of Object.entries(files)) {
    const path = join(cwd, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
  return cwd;
}

async function checkConsumer(t: TestContext, cwd: string, phase: string, target: string) {
  t.diagnostic(`${phase}: Node ${process.version}`);
  const config = ts.readConfigFile(join(cwd, "tsconfig.json"), ts.sys.readFile);
  assert.equal(config.error, undefined);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, cwd);
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)];
  const formatted = ts.formatDiagnostics(diagnostics, {
    getCanonicalFileName: (file) => file,
    getCurrentDirectory: () => cwd,
    getNewLine: () => "\n",
  });
  t.diagnostic(
    `${phase}: TypeScript ${ts.version}, diagnostics=${diagnostics.length}${formatted ? `\n${formatted}` : ""}`,
  );
  assert.equal(diagnostics.length, 0, formatted);

  const consumer = join(cwd, "consumer.ts");
  const source = program.getSourceFile(consumer)!;
  const declaration = source.statements.find(ts.isImportDeclaration)!;
  assert.ok(ts.isStringLiteral(declaration.moduleSpecifier));
  const specifier = declaration.moduleSpecifier.text;
  const resolved = ts.resolveModuleName(specifier, consumer, parsed.options, ts.sys).resolvedModule;
  assert.equal(resolved?.resolvedFileName, join(cwd, target), `${phase}: ${specifier}`);

  // Node does not implement tsconfig paths. Use TypeScript's resolver for this
  // fixture, then let Node load and execute the actual TypeScript modules.
  const runner = `
    import { registerHooks } from "node:module";
    import { fileURLToPath, pathToFileURL } from "node:url";
    import ts from ${JSON.stringify(import.meta.resolve("typescript"))};
    const cwd = ${JSON.stringify(cwd)};
    const options = ${JSON.stringify(parsed.options)};
    registerHooks({ resolve(specifier, context, nextResolve) {
      if (context.parentURL?.startsWith(pathToFileURL(cwd + "/").href)) {
        const resolved = ts.resolveModuleName(specifier, fileURLToPath(context.parentURL), options, ts.sys).resolvedModule;
        if (resolved) return nextResolve(pathToFileURL(resolved.resolvedFileName).href, context);
      }
      return nextResolve(specifier, context);
    }});
    const { kept } = await import(pathToFileURL(${JSON.stringify(consumer)}).href);
    console.log(kept);
  `;
  const output = execFileSync(process.execPath, ["--input-type=module", "--eval", runner], {
    cwd,
    encoding: "utf8",
    timeout: 10_000,
    env: { ...process.env, NODE_DISABLE_COMPILE_CACHE: "1" },
  });
  assert.equal(output, "42\n", `${phase}: executed consumer`);
  t.diagnostic(
    `${phase}: ${specifier} (extension ${extname(specifier) || "none"}) resolves to ${target}; executed consumer=42`,
  );
  return specifier;
}

const cases: { name: string; original: string; paths: Record<string, string[]>; relative: boolean }[] = [
  { name: "exact directory", original: "@utils", paths: { "@utils": ["./src/utils"] }, relative: true },
  { name: "exact name with a slash", original: "@app/utils", paths: { "@app/utils": ["./src/utils"] }, relative: true },
  {
    name: "nested exact name",
    original: "@app/src/utils",
    paths: { "@app/src/utils": ["./src/utils"] },
    relative: true,
  },
  { name: "exact file", original: "@utils", paths: { "@utils": ["./src/utils/index.ts"] }, relative: true },
  {
    name: "exact file with a slash",
    original: "@app/utils",
    paths: { "@app/utils": ["./src/utils/index.ts"] },
    relative: true,
  },
  { name: "wildcard", original: "@app/utils", paths: { "@app/*": ["./src/*"] }, relative: false },
  {
    name: "exact alias with a usable wildcard",
    original: "@app/utils",
    paths: { "@app/utils": ["./src/utils"], "@app/*": ["./src/*"] },
    relative: false,
  },
];

for (const scenario of cases) {
  for (const ext of [undefined, ".js"] as const) {
    test(`${scenario.name}, extension ${ext ?? "auto"}`, async (t) => {
      const cwd = await createProject(t, scenario.paths, scenario.original);
      await checkConsumer(t, cwd, "before", "src/utils/index.ts");
      const result = await unbarrelify({ cwd, write: true, ext });
      assert.deepEqual(result.untraceableImports, []);
      assert.deepEqual(result.deleted, [join(cwd, "src/utils/index.ts")]);
      assert.ok(!existsSync(join(cwd, "src/utils/index.ts")));
      const specifier = await checkConsumer(t, cwd, "after", "src/utils/value.ts");
      assert.equal(specifier, scenario.relative ? `./src/utils/value${ext ?? ""}` : "@app/utils/value");
    });
  }
}

test("an exact alias falls back to an explicit TypeScript extension", async (t) => {
  const cwd = await createProject(t, { "@app/utils": ["./src/utils"] }, "@app/utils");
  await checkConsumer(t, cwd, "before", "src/utils/index.ts");
  await unbarrelify({ cwd, write: true, ext: ".ts" });
  assert.equal(await checkConsumer(t, cwd, "after", "src/utils/value.ts"), "./src/utils/value.ts");
});

for (const target of ["./src/utils/value.ts", "./src/utils/value"]) {
  for (const ext of [undefined, ".js"] as const) {
    test(`preserves a direct file alias to ${target}, extension ${ext ?? "auto"}`, async (t) => {
      const cwd = await createProject(t, { "@app/value": [target] }, "@app/value");
      await checkConsumer(t, cwd, "before", "src/utils/value.ts");
      const consumer = join(cwd, "consumer.ts");
      const original = await readFile(consumer, "utf8");
      const specifier = buildSpecifier(consumer, join(cwd, "src/utils/value.ts"), {
        originalSpecifier: "@app/value",
        aliases: initProjectConfig(cwd).aliases,
        ext,
      });
      await writeFile(consumer, original.replace("@app/value", specifier));
      assert.equal(await checkConsumer(t, cwd, "after", "src/utils/value.ts"), "@app/value");
      await unbarrelify({ cwd, write: true, ext });
      assert.equal(await readFile(consumer, "utf8"), original);
    });
  }
}

for (const alias of ["@utils", "@app/utils"]) {
  test(`preserves the companion wildcard for ${alias} in NodeNext`, async (t) => {
    const cwd = await createProject(
      t,
      {
        [alias]: ["./src/utils/index.ts"],
        [`${alias}/*`]: ["./src/utils/*.ts"],
      },
      alias,
    );
    const config = JSON.parse(await readFile(join(cwd, "tsconfig.json"), "utf8"));
    Object.assign(config.compilerOptions, {
      module: "NodeNext",
      moduleResolution: "NodeNext",
      allowImportingTsExtensions: false,
    });
    await writeFile(join(cwd, "tsconfig.json"), JSON.stringify(config));
    await writeFile(join(cwd, "src/utils/index.ts"), 'export { value } from "./value.js";\n');
    await checkConsumer(t, cwd, "before", "src/utils/index.ts");
    await unbarrelify({ cwd, write: true });
    assert.equal(await checkConsumer(t, cwd, "after", "src/utils/value.ts"), `${alias}/value`);
  });
}

for (const rootPaths of [undefined, { "@root/*": ["./root/*"] }]) {
  test(`respects exact aliases in a referenced project with root paths ${Boolean(rootPaths)}`, async (t) => {
    const cwd = await createProject(t, { "@app/utils": ["./src/utils"] }, "@app/utils");
    const app = join(cwd, "app");
    await mkdir(app);
    for (const file of ["package.json", "tsconfig.json", "src", "consumer.ts"]) {
      await rename(join(cwd, file), join(app, file));
    }
    await writeFile(
      join(cwd, "tsconfig.json"),
      JSON.stringify({
        files: [],
        references: [{ path: "./app" }],
        ...(rootPaths ? { compilerOptions: { paths: rootPaths } } : {}),
      }),
    );
    await checkConsumer(t, app, "before", "src/utils/index.ts");
    await unbarrelify({ cwd, write: true });
    assert.equal(await checkConsumer(t, app, "after", "src/utils/value.ts"), "./src/utils/value");
  });
}

for (const alias of ["@utils", "@app/utils"]) {
  for (const ext of [undefined, ".js", ".ts"] as const) {
    test(`rejects an invalid index companion for ${alias}, extension ${ext ?? "auto"}`, async (t) => {
      const cwd = await createProject(
        t,
        { [alias]: ["./src/utils/index.ts"], [`${alias}/*`]: ["./src/utils/*/index.ts"] },
        alias,
      );
      await mkdir(join(cwd, "src/utils/foo"));
      await rename(join(cwd, "src/utils/value.ts"), join(cwd, "src/utils/foo/index.ts"));
      await writeFile(join(cwd, "src/utils/index.ts"), 'export { value } from "./foo/index";\n');
      await checkConsumer(t, cwd, "before", "src/utils/index.ts");
      const result = await unbarrelify({ cwd, write: true, ext });
      assert.deepEqual(result.untraceableImports, []);
      assert.deepEqual(result.deleted, [join(cwd, "src/utils/index.ts")]);
      assert.ok(!existsSync(join(cwd, "src/utils/index.ts")));
      assert.equal(await checkConsumer(t, cwd, "after", "src/utils/foo/index.ts"), `./src/utils/foo/index${ext ?? ""}`);
    });
  }

  for (const ext of [".js", ".ts"] as const) {
    test(`preserves a valid extension companion for ${alias}, extension ${ext}`, async (t) => {
      const cwd = await createProject(
        t,
        { [alias]: ["./src/utils/index.ts"], [`${alias}/*`]: ["./src/utils/*.ts"] },
        alias,
      );
      await checkConsumer(t, cwd, "before", "src/utils/index.ts");
      const result = await unbarrelify({ cwd, write: true, ext });
      assert.deepEqual(result.untraceableImports, []);
      assert.deepEqual(result.deleted, [join(cwd, "src/utils/index.ts")]);
      assert.ok(!existsSync(join(cwd, "src/utils/index.ts")));
      assert.equal(await checkConsumer(t, cwd, "after", "src/utils/value.ts"), `${alias}/value`);
    });
  }
}
