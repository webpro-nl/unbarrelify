import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import type { TestContext } from "node:test";
import ts from "typescript";
import { parseSpecifier } from "../../src/analyzer.ts";
import { unbarrelify } from "../../src/main.ts";
import { resolveModule } from "../../src/resolver.ts";

async function fixture(t: TestContext, files: Record<string, string>): Promise<string> {
  const dir = realpathSync(await mkdtemp(join(tmpdir(), "unbarrelify-package-imports-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
  return dir;
}

function run(dir: string): string {
  return execFileSync(process.execPath, [join(dir, "consumer.mjs")], {
    encoding: "utf8",
    timeout: 10_000,
    env: { ...process.env, NODE_DISABLE_COMPILE_CACHE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

describe("package import repair4 regressions", () => {
  const execute = (dir: string, file = "consumer.js") =>
    execFileSync(process.execPath, [join(dir, file)], {
      encoding: "utf8",
      timeout: 10_000,
      env: { ...process.env, NODE_DISABLE_COMPILE_CACHE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });

  function compile(dir: string): string[] {
    const config = ts.readConfigFile(join(dir, "tsconfig.json"), ts.sys.readFile);
    assert.equal(config.error, undefined);
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dir);
    const program = ts.createProgram(parsed.fileNames, parsed.options);
    assert.deepEqual(
      ts.getPreEmitDiagnostics(program).map((d) => d.code),
      [],
    );
    const emitted: string[] = [];
    const result = program.emit(undefined, (file, content) => {
      emitted.push(file);
      ts.sys.writeFile(file, content);
    });
    assert.equal(result.emitSkipped, false);
    assert.deepEqual(result.diagnostics, []);
    return emitted;
  }

  for (const inherited of [false, true]) {
    test(`refreshes compiler options between public calls, ${inherited ? "inherited" : "direct"} config`, async (t) => {
      const config = (module: string) =>
        JSON.stringify({
          compilerOptions: { module, allowJs: true, types: [], skipLibCheck: true },
          include: ["**/*"],
        });
      const configName = inherited ? "tsconfig.base.json" : "tsconfig.json";
      const dir = await fixture(t, {
        "package.json": JSON.stringify({
          type: "module",
          imports: { "#utils": { require: "./required/index.mjs", import: "./imported/index.mjs" } },
        }),
        ...(inherited ? { "tsconfig.json": '{"extends":"./tsconfig.base.json"}' } : {}),
        [configName]: config("CommonJS"),
        "warm.ts": 'import { warm } from "./warm-value.mjs"; console.log(warm);\n',
        "warm-value.mjs": "export const warm = 0;\n",
        "required/index.mjs": 'export { value } from "./value.mjs";\n',
        "required/value.mjs": "export const value = 2;\n",
        "imported/index.mjs": 'export { value } from "./value.mjs";\n',
        "imported/value.mjs": "export const value = 1;\n",
        "consumer.js": 'import { value } from "#utils"; console.log(value);\n',
      });
      await unbarrelify({ cwd: dir, files: ["warm.ts"], write: false });
      await writeFile(join(dir, configName), config("ESNext"));
      const before = execute(dir);
      assert.equal(before, "1\n");
      const result = await unbarrelify({ cwd: dir, files: ["**/*.js", "**/*.mjs"], write: true });
      const after = execute(dir);
      t.diagnostic(JSON.stringify({ before, after, inherited }));
      assert.equal(after, before);
      assert.deepEqual(result.deleted, [join(dir, "imported/index.mjs")]);
      assert.match(await readFile(join(dir, "consumer.js"), "utf8"), /from ".\/imported\/value.mjs"/);
    });
  }

  test("overlapping public calls refresh transitive JavaScript programs independently", async (t) => {
    const pkg = JSON.stringify({
      imports: { "#leaf": { require: "./required/value.cjs", import: "./imported/value.mjs" } },
    });
    const cases = await Promise.all(
      ["CommonJS", "Preserve"].map(async (module) => {
        const dir = await fixture(t, {
          "package.json": pkg,
          "tsconfig.json": JSON.stringify({
            compilerOptions: {
              module,
              allowJs: true,
              types: [],
              rootDir: ".",
              outDir: "dist",
              ignoreDeprecations: "6.0",
            },
            include: ["consumer.js"],
            exclude: ["dist"],
          }),
          "warm.js": "export const warm = 0;\n",
          "consumer.js": 'import { warm } from "./warm.js"; console.log(warm);\n',
          "barrel.js": 'export { value } from "#leaf";\n',
          "required/value.cjs": "exports.value = 2;\n",
          "imported/value.mjs": "export const value = 1;\n",
        });
        await unbarrelify({ cwd: dir, files: ["consumer.js"], write: false });
        await writeFile(join(dir, "consumer.js"), 'import { value } from "./barrel.js"; console.log(value);\n');
        const buildAndRun = async () => {
          compile(dir);
          await mkdir(join(dir, "dist/required"), { recursive: true });
          await mkdir(join(dir, "dist/imported"), { recursive: true });
          await writeFile(join(dir, "dist/package.json"), pkg);
          await writeFile(join(dir, "dist/required/value.cjs"), "exports.value = 2;\n");
          await writeFile(join(dir, "dist/imported/value.mjs"), "export const value = 1;\n");
          return execute(join(dir, "dist"));
        };
        const before = await buildAndRun();
        assert.equal(before, module === "CommonJS" ? "2\n" : "1\n");
        await rm(join(dir, "dist"), { recursive: true });
        return { dir, module, before, buildAndRun };
      }),
    );
    const results = await Promise.all(
      cases.map(({ dir }) => unbarrelify({ cwd: dir, files: ["**/*.js"], write: true })),
    );
    for (const [index, { dir, module, before, buildAndRun }] of cases.entries()) {
      const after = await buildAndRun();
      t.diagnostic(JSON.stringify({ module, before, after }));
      assert.equal(after, before);
      assert.deepEqual(results[index].deleted, [join(dir, "barrel.js")]);
    }
  });

  test("declaration-only CommonJS compilation leaves JavaScript ESM import conditions", async (t) => {
    const dir = await fixture(t, {
      "package.json": JSON.stringify({
        type: "module",
        imports: { "#utils": { require: "./required/barrel.js", import: "./imported/barrel.js" } },
      }),
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          module: "CommonJS",
          allowJs: true,
          declaration: true,
          emitDeclarationOnly: true,
          types: [],
          rootDir: ".",
          outDir: "dist",
          ignoreDeprecations: "6.0",
        },
        include: ["**/*.js"],
        exclude: ["dist"],
      }),
      "required/value.js": "export const value = 2;\n",
      "imported/value.js": "export const value = 1;\n",
      "required/barrel.js": 'export { value } from "./value.js";\n',
      "imported/barrel.js": 'export { value } from "./value.js";\n',
      "consumer.js": 'import { value } from "#utils"; console.log(value);\n',
    });
    const beforeEmit = compile(dir);
    assert.ok(beforeEmit.length > 0);
    assert.ok(beforeEmit.every((file) => file.endsWith(".d.ts")));
    assert.equal(existsSync(join(dir, "dist/consumer.js")), false);
    const before = execute(dir);
    assert.equal(before, "1\n");
    await rm(join(dir, "dist"), { recursive: true });
    const result = await unbarrelify({ cwd: dir, files: ["**/*.js"], write: true });
    const afterEmit = compile(dir);
    assert.ok(afterEmit.length > 0);
    assert.ok(afterEmit.every((file) => file.endsWith(".d.ts")));
    assert.equal(existsSync(join(dir, "dist/consumer.js")), false);
    const after = execute(dir);
    t.diagnostic(JSON.stringify({ before, after, beforeEmit, afterEmit }));
    assert.equal(after, before);
    assert.deepEqual(result.deleted, [join(dir, "imported/barrel.js")]);
  });

  for (const extension of ["mts", "mjs"]) {
    test(`dynamic import in ${extension} retains import conditions with CommonJS config`, async (t) => {
      const pkg = JSON.stringify({
        type: "module",
        imports: { "#utils": { import: "./imported/index.mjs", require: "./required/index.mjs" } },
      });
      const dir = await fixture(t, {
        "package.json": pkg,
        "tsconfig.json": JSON.stringify({
          compilerOptions: {
            module: "CommonJS",
            allowJs: true,
            types: [],
            target: "ES2022",
            rootDir: ".",
            outDir: "dist",
            ignoreDeprecations: "6.0",
          },
          include: ["**/*.mts", "**/*.mjs"],
          exclude: ["dist"],
        }),
        [`consumer.${extension}`]: 'import("#utils").then((value) => console.log(value.value));\n',
        "static.mjs": 'import { value } from "./imported/index.mjs"; console.log(value);\n',
        "imported/index.mjs": 'export { value } from "./value.mjs";\n',
        "imported/value.mjs": "export const value = 1;\n",
        "required/index.mjs": 'export { value } from "./value.mjs";\n',
        "required/value.mjs": "export const value = 2;\n",
      });
      const buildAndRun = async () => {
        compile(dir);
        await writeFile(join(dir, "dist/package.json"), pkg);
        assert.match(await readFile(join(dir, "dist/consumer.mjs"), "utf8"), /import\(["']#utils["']\)/);
        return execute(join(dir, "dist"), "consumer.mjs");
      };
      assert.equal(await buildAndRun(), "1\n");
      await rm(join(dir, "dist"), { recursive: true });
      const result = await unbarrelify({ cwd: dir, files: ["**/*.mts", "**/*.mjs"], write: true });
      assert.ok(!result.deleted.includes(join(dir, "imported/index.mjs")));
      assert.equal(await buildAndRun(), "1\n");
    });
  }

  for (const module of ["CommonJS", "Preserve", "NodeNext"]) {
    test(`dynamic import in compiled JavaScript ${module} protects its runtime barrel`, async (t) => {
      const pkg = JSON.stringify({ imports: { "#utils": { require: "./barrel.js", import: "./other.js" } } });
      const dir = await fixture(t, {
        "package.json": pkg,
        "tsconfig.json": JSON.stringify({
          compilerOptions: {
            module,
            allowJs: true,
            types: [],
            target: "ES2022",
            rootDir: ".",
            outDir: "dist",
            ignoreDeprecations: "6.0",
          },
          include: ["consumer.js", "other.js"],
          exclude: ["dist"],
        }),
        "value.js": "export const value = 1;\n",
        "barrel.js": 'export { value } from "./value.js";\n',
        "other.js": "export const value = 2;\n",
        "consumer.js":
          'import { value } from "./barrel.js"; import("#utils").then((dynamic) => console.log(value, dynamic.value));\n',
      });
      const buildAndRun = async () => {
        compile(dir);
        await writeFile(join(dir, "dist/package.json"), pkg);
        const emitted = await readFile(join(dir, "dist/consumer.js"), "utf8");
        assert.match(emitted, module === "CommonJS" ? /require\(["']#utils["']\)/ : /import\(["']#utils["']\)/);
        return execute(join(dir, "dist"));
      };
      const before = await buildAndRun();
      assert.equal(before, module === "CommonJS" ? "1 1\n" : "1 2\n");
      await rm(join(dir, "dist"), { recursive: true });
      const result = await unbarrelify({ cwd: dir, files: ["**/*.js"], write: true });
      const after = await buildAndRun();
      t.diagnostic(JSON.stringify({ module, before, after, deleted: result.deleted, preserved: result.preserved }));
      assert.equal(after, before);
      if (module === "CommonJS") {
        assert.equal(existsSync(join(dir, "barrel.js")), true);
        assert.ok(
          result.preserved.some((item) => item.path === join(dir, "barrel.js") && item.reason === "dynamic-import"),
        );
      } else {
        assert.deepEqual(result.deleted, [join(dir, "barrel.js")]);
      }
    });
  }
});

describe("package import repair3 regressions", () => {
  for (const suffix of ["?raw#fragment", "?raw", "#fragment", ""]) {
    test(`relative consumer retains suffix ${suffix || "none"} through a package leaf`, async (t) => {
      const dir = await fixture(t, {
        "package.json": JSON.stringify({ type: "module", imports: { "#leaf": "./value.mjs" } }),
        "value.mjs": "export const value = 1;\n",
        "barrel.mjs": 'export { value } from "#leaf";\n',
        "consumer.mjs": `import { value } from "./barrel.mjs${suffix}"; console.log(value);\n`,
      });
      assert.equal(run(dir), "1\n");
      const result = await unbarrelify({ cwd: dir, files: ["**/*.mjs"], write: true });
      assert.equal(run(dir), "1\n");
      assert.equal(
        await readFile(join(dir, "consumer.mjs"), "utf8"),
        `import { value } from "${suffix ? `./value.mjs${suffix}` : "#leaf"}"; console.log(value);\n`,
      );
      assert.deepEqual(result.deleted, [join(dir, "barrel.mjs")]);
    });
  }

  test("loader prefix retains relative leaf semantics", async (t) => {
    const dir = await fixture(t, {
      "package.json": JSON.stringify({ type: "module", imports: { "#leaf": "./value.mjs" } }),
      "value.mjs": "export const value = 1;\n",
      "barrel.mjs": 'export { value } from "#leaf";\n',
      "consumer.mjs": 'import { value } from "loader!./barrel.mjs"; console.log(value);\n',
    });
    const result = await unbarrelify({ cwd: dir, files: ["**/*.mjs"], write: true });
    assert.equal(
      await readFile(join(dir, "consumer.mjs"), "utf8"),
      'import { value } from "loader!./value.mjs"; console.log(value);\n',
    );
    assert.deepEqual(result.deleted, [join(dir, "barrel.mjs")]);
  });

  for (const namespace of [false, true]) {
    test(`${namespace ? "unsafe namespace" : "star re-export"} retains relative leaf suffixes`, async (t) => {
      const dir = await fixture(t, {
        "package.json": JSON.stringify({ type: "module", imports: { "#leaf": "./value.mjs" } }),
        "value.mjs": "export const value = 1;\n",
        "other.mjs": "export const other = 2;\n",
        "barrel.mjs": 'export * from "#leaf"; export * from "./other.mjs";\n',
        "facade.mjs": 'export * from "./barrel.mjs?raw#fragment"; export const marker = 0;\n',
        "consumer.mjs": namespace
          ? 'import * as values from "./barrel.mjs?raw#fragment"; console.log(values.value, values.other);\n'
          : 'import { value, other } from "./facade.mjs"; console.log(value, other);\n',
      });
      assert.equal(run(dir), "1 2\n");
      const result = await unbarrelify({ cwd: dir, files: ["**/*.mjs"], write: true, unsafeNamespace: namespace });
      assert.equal(run(dir), "1 2\n");
      assert.deepEqual(result.deleted, [join(dir, "barrel.mjs")]);
      assert.match(
        await readFile(join(dir, namespace ? "consumer.mjs" : "facade.mjs"), "utf8"),
        /\.\/value\.mjs\?raw#fragment/,
      );
    });
  }

  for (const config of [undefined, { allowJs: false }, { allowJs: true, include: ["tools"] }]) {
    for (const type of ["module", undefined]) {
      test(`JavaScript ESM ${type ?? "detected"} ignores unrelated config ${JSON.stringify(config)}`, async (t) => {
        const dir = await fixture(t, {
          "package.json": JSON.stringify({
            type,
            imports: { "#utils": { require: "./required/barrel.js", import: "./imported/barrel.js" } },
          }),
          ...(config
            ? {
                "tsconfig.json": JSON.stringify({
                  compilerOptions: { module: "CommonJS", allowJs: config.allowJs, types: [] },
                  include: "include" in config ? config.include : ["**/*"],
                }),
                "tools/build.ts": "export const tool = 1;\n",
              }
            : {}),
          "required/value.mjs": "export const value = 2;\n",
          "imported/value.mjs": "export const value = 1;\n",
          "required/barrel.js": 'export { value } from "./value.mjs";\n',
          "imported/barrel.js": 'export { value } from "./value.mjs";\n',
          "consumer.js": 'import { value } from "#utils"; console.log(value);\n',
        });
        const execute = () =>
          execFileSync(process.execPath, [join(dir, "consumer.js")], {
            encoding: "utf8",
            timeout: 10_000,
            env: { ...process.env, NODE_DISABLE_COMPILE_CACHE: "1" },
            stdio: ["ignore", "pipe", "pipe"],
          });
        assert.equal(execute(), "1\n");
        const result = await unbarrelify({ cwd: dir, files: ["**/*.js", "**/*.mjs"], write: true });
        assert.equal(execute(), "1\n");
        assert.ok(result.deleted.includes(join(dir, "imported/barrel.js")));
        assert.match(await readFile(join(dir, "consumer.js"), "utf8"), /from ".\/imported\/value.mjs"/);
      });
    }
  }

  test("excluded JavaScript barrel keeps its own ESM conditional re-export", async (t) => {
    const dir = await fixture(t, {
      "package.json": '{"type":"module"}',
      "tsconfig.json": JSON.stringify({ compilerOptions: { module: "CommonJS", allowJs: false }, include: ["tools"] }),
      "tools/build.ts": "export const tool = 1;\n",
      "src/package.json": JSON.stringify({
        type: "module",
        imports: {
          "#leaf": { require: "./required.js", import: "./imported.js" },
        },
      }),
      "src/imported.js": "export const value = 1;\n",
      "src/required.js": "export const value = 2;\n",
      "src/barrel.js": 'export { value } from "#leaf";\n',
      "consumer.mjs": 'import { value } from "./src/barrel.js"; console.log(value);\n',
    });
    assert.equal(run(dir), "1\n");
    const result = await unbarrelify({ cwd: dir, files: ["**/*.js", "**/*.mjs"], write: true });
    assert.equal(run(dir), "1\n");
    assert.deepEqual(result.deleted, [join(dir, "src/barrel.js")]);
    assert.match(await readFile(join(dir, "consumer.mjs"), "utf8"), /src\/imported.js/);
  });

  for (const dynamic of [false, true]) {
    test(`JavaScript ${dynamic ? "dynamic" : "static"} import stays distinct from require`, async (t) => {
      const original = dynamic
        ? 'const required = require("#utils"); import("#utils").then(({ value }) => console.log(value, required.value));\n'
        : 'import { createRequire } from "node:module"; import { value } from "#utils"; const require = createRequire(import.meta.url); console.log(value, require("#utils").value);\n';
      const dir = await fixture(t, {
        "package.json": JSON.stringify({
          imports: {
            "#utils": { require: "./required.cjs", import: "./imported/index.mjs" },
          },
        }),
        "required.cjs": "exports.value = 2;\n",
        "imported/index.mjs": 'export { value } from "./value.mjs";\n',
        "imported/value.mjs": "export const value = 1;\n",
        "consumer.js": original,
      });
      const execute = () =>
        execFileSync(process.execPath, [join(dir, "consumer.js")], {
          encoding: "utf8",
          timeout: 10_000,
          env: { ...process.env, NODE_DISABLE_COMPILE_CACHE: "1" },
          stdio: ["ignore", "pipe", "pipe"],
        });
      assert.equal(execute(), "1 2\n");
      const result = await unbarrelify({ cwd: dir, files: ["**/*.js", "**/*.mjs", "**/*.cjs"], write: true });
      assert.equal(execute(), "1 2\n");
      const content = await readFile(join(dir, "consumer.js"), "utf8");
      assert.match(content, /require\("#utils"\)/);
      if (dynamic) {
        assert.equal(content, original);
        assert.deepEqual(result.deleted, []);
        assert.ok(result.preserved.some((item) => item.path === join(dir, "imported/index.mjs")));
      } else {
        assert.deepEqual(result.deleted, [join(dir, "imported/index.mjs")]);
      }
    });
  }

  for (const module of ["CommonJS", "Preserve"]) {
    for (const transitive of [false, true]) {
      test(`compiled JavaScript ${module}, ${transitive ? "transitive" : "root"} inclusion`, async (t) => {
        const expected = module === "CommonJS" ? "2\n" : "1\n";
        const pkg = JSON.stringify({
          imports: {
            "#leaf": { require: "./required/value.cjs", import: "./imported/value.mjs" },
          },
        });
        const dir = await fixture(t, {
          "package.json": pkg,
          "tsconfig.json": JSON.stringify({
            compilerOptions: {
              module,
              allowJs: true,
              types: [],
              rootDir: ".",
              outDir: "dist",
              ignoreDeprecations: "6.0",
            },
            include: transitive ? ["consumer.js"] : ["*.js"],
            exclude: ["dist"],
          }),
          "required/value.cjs": "exports.value = 2;\n",
          "imported/value.mjs": "export const value = 1;\n",
          "barrel.js": 'export { value } from "#leaf";\n',
          "consumer.js": 'import { value } from "./barrel.js"; console.log(value);\n',
        });
        const execute = async () => {
          const config = ts.readConfigFile(join(dir, "tsconfig.json"), ts.sys.readFile);
          const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dir);
          const program = ts.createProgram(parsed.fileNames, parsed.options);
          assert.equal(!!program.getSourceFile(join(dir, "barrel.js")), existsSync(join(dir, "barrel.js")));
          assert.deepEqual(
            ts.getPreEmitDiagnostics(program).map((d) => d.code),
            [],
          );
          assert.equal(program.emit().emitSkipped, false);
          await mkdir(join(dir, "dist/required"), { recursive: true });
          await mkdir(join(dir, "dist/imported"), { recursive: true });
          await writeFile(join(dir, "dist/package.json"), pkg);
          await writeFile(join(dir, "dist/required/value.cjs"), "exports.value = 2;\n");
          await writeFile(join(dir, "dist/imported/value.mjs"), "export const value = 1;\n");
          const content = await readFile(join(dir, "dist/consumer.js"), "utf8");
          assert.match(content, module === "CommonJS" ? /require\(/ : /import /);
          return execFileSync(process.execPath, [join(dir, "dist/consumer.js")], {
            encoding: "utf8",
            timeout: 10_000,
            env: { ...process.env, NODE_DISABLE_COMPILE_CACHE: "1" },
            stdio: ["ignore", "pipe", "pipe"],
          });
        };
        assert.equal(await execute(), expected);
        assert.equal(
          resolveModule(join(dir, "barrel.js"), "#leaf", null),
          join(dir, module === "CommonJS" ? "required/value.cjs" : "imported/value.mjs"),
        );
        await rm(join(dir, "dist"), { recursive: true });
        const result = await unbarrelify({ cwd: dir, files: ["**/*.js"], write: true });
        assert.equal(await execute(), expected);
        assert.deepEqual(result.deleted, [join(dir, "barrel.js")]);
      });
    }
  }
});

const mappings = [
  { name: "exact key", specifier: "#utils", imports: { "#utils": "./src/utils/index.mjs" } },
  { name: "exact key with a slash", specifier: "#app/utils", imports: { "#app/utils": "./src/utils/index.mjs" } },
  {
    name: "wildcard mapping to directories",
    specifier: "#app/utils",
    imports: { "#app/*": "./src/*/index.mjs" },
  },
  {
    name: "wildcard mapping to files",
    specifier: "#app/utils",
    imports: { "#app/*": "./src/*.mjs" },
    barrel: "src/utils.mjs",
    source: "./utils/value.mjs",
    relative: "./utils.mjs",
    replacement: "#app/utils/value",
  },
  {
    name: "alternate key with an extensionless target",
    specifier: "#app/utils",
    imports: { "#app/utils": "./src/utils/index.mjs", "#app/utils/value": "./src/utils/value" },
  },
];

describe("package import resolution", () => {
  for (const ext of [undefined, ".mjs"]) {
    test(`ESM conditions select import after require, ${ext ?? "automatic"}`, async (t) => {
      const dir = await fixture(t, {
        "package.json": JSON.stringify({
          type: "module",
          imports: { "#utils": { require: "./src/require/index.mjs", import: "./src/import/index.mjs" } },
        }),
        "src/require/index.mjs": 'export { value } from "./value.mjs";\n',
        "src/require/value.mjs": "export const value = 2;\n",
        "src/import/index.mjs": 'export { value } from "./value.mjs";\n',
        "src/import/value.mjs": "export const value = 1;\n",
        "consumer.mjs": 'import { value } from "#utils"; console.log(value);\n',
      });
      assert.equal(run(dir), "1\n");
      await unbarrelify({ cwd: dir, files: ["**/*.mjs"], write: true, ...(ext ? { ext } : {}) });
      assert.equal(run(dir), "1\n");
      assert.match(await readFile(join(dir, "consumer.mjs"), "utf8"), /src\/import\/value\.mjs/);
    });
  }

  for (const namespace of [false, true]) {
    test(`local package ${namespace ? "namespace-star" : "export-star"} survives barrel removal`, async (t) => {
      const dir = await fixture(t, {
        "package.json": JSON.stringify({ type: "module", imports: { "#internal": "./src/internal/index.mjs" } }),
        "src/internal/index.mjs": 'export { value } from "./value.mjs";\n',
        "src/internal/value.mjs": "export const value = 42;\n",
        "src/facade.mjs": namespace ? 'export * as ns from "#internal";\n' : 'export * from "#internal";\n',
        "consumer.mjs": namespace
          ? 'import { ns } from "./src/facade.mjs"; console.log(ns.value);\n'
          : 'import { value } from "./src/facade.mjs"; console.log(value);\n',
      });
      assert.equal(run(dir), "42\n");
      await unbarrelify({ cwd: dir, files: ["**/*.mjs"], write: true });
      assert.equal(run(dir), "42\n");
    });
  }

  test("hash paths without package imports remain valid TypeScript", async (t) => {
    const dir = await fixture(t, {
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          module: "ESNext",
          moduleResolution: "Bundler",
          noEmit: true,
          types: [],
          paths: { "#/*": ["./src/*"] },
        },
      }),
      "src/utils/value.ts": "export const value = 42;\n",
      "src/utils/index.ts": 'export { value } from "./value";\n',
      "consumer.ts": 'import { value } from "#/utils"; export const kept: number = value;\n',
    });
    const check = () => {
      const config = ts.readConfigFile(join(dir, "tsconfig.json"), ts.sys.readFile);
      const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dir);
      assert.deepEqual(
        ts.getPreEmitDiagnostics(ts.createProgram(parsed.fileNames, parsed.options)).map((d) => d.code),
        [],
      );
    };
    check();
    await unbarrelify({ cwd: dir, files: ["**/*.ts"], write: true });
    check();
    assert.equal(
      await readFile(join(dir, "consumer.ts"), "utf8"),
      'import { value } from "#/utils/value"; export const kept: number = value;\n',
    );
    assert.equal(existsSync(join(dir, "src/utils/index.ts")), false);
  });

  test("NodeNext package js targets resolve TypeScript sources and emit executable js", async (t) => {
    const pkg = JSON.stringify({ type: "module", imports: { "#utils": "./src/utils/index.js" } });
    const dir = await fixture(t, {
      "package.json": pkg,
      "tsconfig.json": JSON.stringify({
        compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", types: [], rootDir: ".", outDir: "dist" },
        exclude: ["dist"],
      }),
      "src/utils/value.ts": "export const value = 42;\n",
      "src/utils/index.ts": 'export { value } from "./value.js";\n',
      "consumer.mts":
        'import { value } from "#utils"; declare const console: { log(value: number): void }; console.log(value);\n',
    });
    const check = async () => {
      const config = ts.readConfigFile(join(dir, "tsconfig.json"), ts.sys.readFile);
      const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dir);
      const program = ts.createProgram(parsed.fileNames, parsed.options);
      assert.deepEqual(
        ts.getPreEmitDiagnostics(program).map((d) => d.code),
        [],
      );
      assert.equal(program.emit().emitSkipped, false);
      await writeFile(join(dir, "dist/package.json"), pkg);
      assert.equal(run(join(dir, "dist")), "42\n");
    };
    await check();
    await rm(join(dir, "dist"), { recursive: true });
    await unbarrelify({ cwd: dir, files: ["**/*.ts", "**/*.mts"], write: true });
    await check();
    assert.match(await readFile(join(dir, "consumer.mts"), "utf8"), /\.\/src\/utils\/value\.js/);
    assert.equal(existsSync(join(dir, "src/utils/index.ts")), false);
  });
});

describe("package import condition and TypeScript regressions", () => {
  test("Bundler ESM in a CommonJS package selects import conditions", async (t) => {
    const dir = await fixture(t, {
      "package.json": JSON.stringify({
        type: "commonjs",
        imports: {
          "#utils": {
            require: "./required/index.ts",
            import: "./imported/index.ts",
          },
          "#leaf": "./imported/value.ts",
        },
      }),
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          module: "ESNext",
          moduleResolution: "Bundler",
          noEmit: true,
          types: [],
        },
      }),
      "required/index.ts": 'export { value } from "./value";\n',
      "required/value.ts": "export const value = 2;\n",
      "imported/index.ts": 'export { value } from "#leaf";\n',
      "imported/value.ts": "export const value = 1;\n",
      "consumer.ts": 'import { value } from "#utils"; export const kept: 1 = value;\n',
    });
    const check = () => {
      const config = ts.readConfigFile(join(dir, "tsconfig.json"), ts.sys.readFile);
      const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dir);
      return ts.getPreEmitDiagnostics(ts.createProgram(parsed.fileNames, parsed.options)).map((d) => d.code);
    };
    assert.deepEqual(check(), []);
    assert.equal(resolveModule(join(dir, "consumer.ts"), "#utils", null), join(dir, "imported/index.ts"));
    await unbarrelify({ cwd: dir, files: ["**/*.ts"], write: true });
    assert.deepEqual(check(), []);
    assert.match(await readFile(join(dir, "consumer.ts"), "utf8"), /from "#leaf"/);
    assert.equal(existsSync(join(dir, "imported/index.ts")), false);
  });

  test("CommonJS dynamic import uses import conditions and preserves its barrel", async (t) => {
    const dir = await fixture(t, {
      "package.json": JSON.stringify({
        imports: {
          "#utils": {
            require: "./required/index.mjs",
            import: "./imported/index.mjs",
          },
        },
      }),
      "required/index.mjs": 'export { value } from "./value.mjs";\n',
      "required/value.mjs": "export const value = 2;\n",
      "imported/index.mjs": 'export { value } from "./value.mjs";\n',
      "imported/value.mjs": "export const value = 1;\n",
      "consumer.cjs": 'import("#utils").then(({ value }) => console.log(value));\n',
      "static.mjs": 'import { value } from "#utils"; export const kept = value;\n',
    });
    const execute = () =>
      execFileSync(process.execPath, [join(dir, "consumer.cjs")], {
        encoding: "utf8",
        timeout: 10_000,
        env: { ...process.env, NODE_DISABLE_COMPILE_CACHE: "1" },
      });
    const before = execute();
    assert.equal(before, "1\n");
    await unbarrelify({ cwd: dir, files: ["**/*.mjs", "**/*.cjs"], write: true });
    const after = execute();
    t.diagnostic(JSON.stringify({ node: process.version, extension: ".cjs", before, after }));
    assert.equal(after, before);
    assert.equal(existsSync(join(dir, "imported/index.mjs")), true);
  });

  test("keeps a direct ts barrel when its leaf key has a different consumer meaning", async (t) => {
    const original = 'import { value } from "#utils"; export const kept: number = value;\n';
    const dir = await fixture(t, {
      "package.json": JSON.stringify({
        type: "module",
        imports: {
          "#utils": "./src/barrel.ts",
          "#leaf": "./wrong.ts",
        },
      }),
      "src/package.json": JSON.stringify({ type: "module", imports: { "#leaf": "./value.ts" } }),
      "src/barrel.ts": 'export { value } from "#leaf";\n',
      "src/value.ts": "export const value = 42;\n",
      "wrong.ts": "export const value = 99;\n",
      "consumer.mts": original,
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          noEmit: true,
          rootDir: ".",
          types: [],
        },
      }),
    });
    const check = () => {
      const config = ts.readConfigFile(join(dir, "tsconfig.json"), ts.sys.readFile);
      const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dir);
      return ts.getPreEmitDiagnostics(ts.createProgram(parsed.fileNames, parsed.options)).map((d) => d.code);
    };
    assert.deepEqual(check(), []);
    const result = await unbarrelify({ cwd: dir, files: ["**/*.ts", "**/*.mts"], write: true });
    assert.deepEqual(check(), []);
    assert.equal(await readFile(join(dir, "consumer.mts"), "utf8"), original);
    assert.deepEqual(result.deleted, []);
    assert.equal(existsSync(join(dir, "src/barrel.ts")), true);
  });

  test("keeps a direct ts barrel when its slash leaf key is absent in the consumer", async (t) => {
    const original = 'import { value } from "#utils"; export const kept: number = value;\n';
    const dir = await fixture(t, {
      "package.json": JSON.stringify({
        type: "module",
        imports: {
          "#utils": "./src/barrel.ts",
        },
      }),
      "src/package.json": JSON.stringify({ type: "module", imports: { "#src/value": "./value.ts" } }),
      "src/barrel.ts": 'export { value } from "#src/value";\n',
      "src/value.ts": "export const value = 42;\n",
      "wrong.ts": "export const value = 99;\n",
      "consumer.mts": original,
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          noEmit: true,
          rootDir: ".",
          types: [],
        },
      }),
    });
    const check = () => {
      const config = ts.readConfigFile(join(dir, "tsconfig.json"), ts.sys.readFile);
      const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dir);
      return ts.getPreEmitDiagnostics(ts.createProgram(parsed.fileNames, parsed.options)).map((d) => d.code);
    };
    assert.deepEqual(check(), []);
    const result = await unbarrelify({ cwd: dir, files: ["**/*.ts", "**/*.mts"], write: true });
    assert.deepEqual(check(), []);
    assert.equal(await readFile(join(dir, "consumer.mts"), "utf8"), original);
    assert.deepEqual(result.deleted, []);
    assert.equal(existsSync(join(dir, "src/barrel.ts")), true);
  });

  for (const ext of [undefined, ".mjs"]) {
    test(`module-sync takes precedence, ${ext ?? "automatic"}`, async (t) => {
      const dir = await fixture(t, {
        "package.json": JSON.stringify({
          type: "module",
          imports: {
            "#utils": { "module-sync": "./sync/index.mjs", import: "./esm/index.mjs" },
          },
        }),
        "sync/index.mjs": 'export { value } from "./value.mjs";\n',
        "sync/value.mjs": "export const value = 1;\n",
        "esm/index.mjs": 'export { value } from "./value.mjs";\n',
        "esm/value.mjs": "export const value = 2;\n",
        "consumer.mjs": 'import { value } from "#utils"; console.log(value);\n',
      });
      const before = run(dir);
      assert.equal(before, "1\n");
      await unbarrelify({ cwd: dir, files: ["**/*.mjs"], write: true, ...(ext ? { ext } : {}) });
      const after = run(dir);
      t.diagnostic(JSON.stringify({ node: process.version, extension: ".mjs", before, after }));
      assert.equal(after, before);
      assert.equal(existsSync(join(dir, "sync/index.mjs")), false);
    });
  }

  for (const nested of [false, true]) {
    test(`direct ts targets retain NodeNext typecheck, ${nested ? "different consumer scope" : "same scope"}`, async (t) => {
      const consumer = nested ? "app/consumer.mts" : "consumer.mts";
      const dir = await fixture(t, {
        "package.json": JSON.stringify({
          type: "module",
          imports: {
            "#utils": "./src/index.ts",
            "#leaf": "./src/value.ts",
          },
        }),
        "tsconfig.json": JSON.stringify({
          compilerOptions: {
            module: "NodeNext",
            moduleResolution: "NodeNext",
            rootDir: ".",
            noEmit: true,
            types: [],
          },
        }),
        "src/index.ts": 'export { value } from "#leaf";\n',
        "src/value.ts": "export const value = 42;\n",
        ...(nested
          ? {
              "app/package.json": JSON.stringify({ type: "module", imports: { "#leaf": "./wrong.ts" } }),
              "app/wrong.ts": "export const value = 99;\n",
            }
          : {}),
        [consumer]: `import { value } from "${nested ? "../src/index.js" : "#utils"}"; export const kept: number = value;\n`,
      });
      const check = () => {
        const config = ts.readConfigFile(join(dir, "tsconfig.json"), ts.sys.readFile);
        const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dir);
        return ts.getPreEmitDiagnostics(ts.createProgram(parsed.fileNames, parsed.options)).map((d) => d.code);
      };
      const before = check();
      assert.deepEqual(before, []);
      await unbarrelify({ cwd: dir, files: ["**/*.ts", "**/*.mts"], write: true });
      const after = check();
      t.diagnostic(JSON.stringify({ node: process.version, extension: ".mts/.ts", before, after }));
      assert.deepEqual(after, []);
      const content = await readFile(join(dir, consumer), "utf8");
      if (nested) assert.doesNotMatch(content, /from "#leaf"/);
      else assert.match(content, /from "#leaf"/);
      assert.equal(existsSync(join(dir, "src/index.ts")), false);
    });
  }

  for (const sourceExt of [".cts", ".ts"]) {
    test(`CommonJS ${sourceExt} emits cjs/js using require conditions`, async (t) => {
      const outExt = sourceExt === ".cts" ? ".cjs" : ".js";
      const pkg = JSON.stringify({
        type: "commonjs",
        imports: {
          "#utils": {
            require: `./required/index${outExt}`,
            import: `./imported/index${outExt}`,
          },
        },
      });
      const dir = await fixture(t, {
        "package.json": pkg,
        "tsconfig.json": JSON.stringify({
          compilerOptions: {
            module: "NodeNext",
            moduleResolution: "NodeNext",
            rootDir: ".",
            outDir: "dist",
            types: [],
          },
          exclude: ["dist"],
        }),
        [`required/index${sourceExt}`]: `export { value } from "./value${outExt}";\n`,
        [`required/value${sourceExt}`]: "export const value = 1;\n",
        [`imported/index${sourceExt}`]: `export { value } from "./value${outExt}";\n`,
        [`imported/value${sourceExt}`]: "export const value = 2;\n",
        [`consumer${sourceExt}`]:
          'import { value } from "#utils"; declare const console: { log(value: number): void }; console.log(value);\n',
      });
      const execute = async () => {
        const config = ts.readConfigFile(join(dir, "tsconfig.json"), ts.sys.readFile);
        const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dir);
        const program = ts.createProgram(parsed.fileNames, parsed.options);
        assert.deepEqual(
          ts.getPreEmitDiagnostics(program).map((d) => d.code),
          [],
        );
        assert.equal(program.emit().emitSkipped, false);
        await writeFile(join(dir, "dist/package.json"), pkg);
        return execFileSync(process.execPath, [join(dir, `dist/consumer${outExt}`)], {
          encoding: "utf8",
          timeout: 10_000,
          env: { ...process.env, NODE_DISABLE_COMPILE_CACHE: "1" },
        });
      };
      const before = await execute();
      assert.equal(before, "1\n");
      await rm(join(dir, "dist"), { recursive: true });
      await unbarrelify({ cwd: dir, files: [`**/*${sourceExt}`], write: true });
      const after = await execute();
      t.diagnostic(JSON.stringify({ node: process.version, extension: `${sourceExt} -> ${outExt}`, before, after }));
      assert.equal(after, before);
      assert.equal(existsSync(join(dir, `required/index${sourceExt}`)), false);
    });
  }
});

describe("package import specifiers", () => {
  for (const mapping of mappings) {
    for (const ext of [undefined, ".mjs"]) {
      test(`${mapping.name}, ${ext ?? "automatic extension"}: rewrites executable mixed consumers`, async (t) => {
        const barrel = mapping.barrel ?? "src/utils/index.mjs";
        const dir = await fixture(t, {
          "package.json": JSON.stringify({ type: "module", imports: mapping.imports }),
          "src/utils/value.mjs": "export const value = 42;\n",
          [barrel]: `export { value } from "${mapping.source ?? "./value.mjs"}";\n`,
          "src/hash.mjs": `import { value } from "${mapping.specifier}"; export const hashed = value;\n`,
          "src/relative.mjs": `import { value } from "${mapping.relative ?? "./utils/index.mjs"}"; export const relative = value;\n`,
          "src/facade.mjs": `export { value } from "${mapping.specifier}"; export const marker = 1;\n`,
          "consumer.mjs":
            'import { hashed } from "./src/hash.mjs"; import { relative } from "./src/relative.mjs"; ' +
            'import { value, marker } from "./src/facade.mjs"; console.log(hashed, relative, value, marker);\n',
        });
        assert.equal(run(dir), "42 42 42 1\n");
        // Exercise the installed resolver before analysis or rewriting can affect the fixture.
        assert.equal(resolveModule(join(dir, "src/hash.mjs"), mapping.specifier, null), join(dir, barrel));

        const result = await unbarrelify({ cwd: dir, files: ["**/*.mjs"], write: true, ...(ext ? { ext } : {}) });

        assert.equal(run(dir), "42 42 42 1\n");
        assert.deepEqual(result.deleted, [join(dir, barrel)]);
        assert.equal(existsSync(join(dir, barrel)), false);
        assert.deepEqual(result.untraceableImports, []);
        const replacement = mapping.replacement ?? "./utils/value.mjs";
        assert.equal(
          await readFile(join(dir, "src/hash.mjs"), "utf8"),
          `import { value } from "${replacement}"; export const hashed = value;\n`,
        );
        assert.equal(
          await readFile(join(dir, "src/facade.mjs"), "utf8"),
          `export { value } from "${replacement}"; export const marker = 1;\n`,
        );
        assert.equal(
          await readFile(join(dir, "src/relative.mjs"), "utf8"),
          'import { value } from "./utils/value.mjs"; export const relative = value;\n',
        );
      });
    }
  }

  for (const mapping of mappings) {
    test(`${mapping.name}: preserves a dynamically imported barrel`, async (t) => {
      const barrel = mapping.barrel ?? "src/utils/index.mjs";
      const dynamic = `const { value } = await import("${mapping.specifier}"); console.log(value);\n`;
      const dir = await fixture(t, {
        "package.json": JSON.stringify({ type: "module", imports: mapping.imports }),
        "src/utils/value.mjs": "export const value = 42;\n",
        [barrel]: `export { value } from "${mapping.source ?? "./value.mjs"}";\n`,
        "src/static.mjs": `import { value } from "${mapping.relative ?? "./utils/index.mjs"}"; export const kept = value;\n`,
        "consumer.mjs": dynamic,
      });
      assert.equal(run(dir), "42\n");
      const result = await unbarrelify({ cwd: dir, files: ["**/*.mjs"], write: true });
      assert.equal(run(dir), "42\n");
      assert.deepEqual(result.deleted, []);
      assert.ok(result.preserved.some((item) => item.path === join(dir, barrel)));
      assert.equal(await readFile(join(dir, "consumer.mjs"), "utf8"), dynamic);
    });
  }

  test("explicit extension overrides the package target extension", async (t) => {
    const dir = await fixture(t, {
      "package.json": JSON.stringify({ type: "module", imports: { "#utils": "./src/index.mjs" } }),
      "src/value.js": "export const value = 42;\n",
      "src/value.mjs": "export const value = 42;\n",
      "src/index.mjs": 'export { value } from "./value.mjs";\n',
      "consumer.mjs": 'import { value } from "#utils"; console.log(value);\n',
    });
    assert.equal(run(dir), "42\n");
    await unbarrelify({ cwd: dir, files: ["**/*.mjs"], write: true, ext: ".js" });
    assert.equal(run(dir), "42\n");
    assert.equal(
      await readFile(join(dir, "consumer.mjs"), "utf8"),
      'import { value } from "./src/value.js"; console.log(value);\n',
    );
    assert.equal(existsSync(join(dir, "src/index.mjs")), false);
  });

  test("ordinary relative query and fragment imports still execute after rewriting", async (t) => {
    const dir = await fixture(t, {
      "package.json": '{"type":"module"}',
      "value.mjs": "export const value = 42;\n",
      "barrel.mjs": 'export { value } from "./value.mjs";\n',
      "consumer.mjs": 'import { value } from "./barrel.mjs?raw#fragment"; console.log(value);\n',
    });
    assert.equal(run(dir), "42\n");
    await unbarrelify({ cwd: dir, files: ["**/*.mjs"], write: true });
    assert.equal(run(dir), "42\n");
    assert.equal(
      await readFile(join(dir, "consumer.mjs"), "utf8"),
      'import { value } from "./value.mjs?raw#fragment"; console.log(value);\n',
    );
  });

  test("ordinary wildcard aliases remain valid TypeScript imports", async (t) => {
    const dir = await fixture(t, {
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          noEmit: true,
          types: [],
          paths: { "@app/*": ["./src/*"] },
        },
      }),
      "src/utils/value.ts": "export const value = 42;\n",
      "src/utils/index.ts": 'export { value } from "./value";\n',
      "consumer.ts": 'import { value } from "@app/utils"; export const kept: number = value;\n',
    });
    const check = () => {
      const config = ts.readConfigFile(join(dir, "tsconfig.json"), ts.sys.readFile);
      const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dir);
      assert.deepEqual(parsed.errors, []);
      const program = ts.createProgram(parsed.fileNames, parsed.options);
      assert.deepEqual(
        ts.getPreEmitDiagnostics(program).map((diagnostic) => diagnostic.code),
        [],
      );
    };
    check();
    await unbarrelify({ cwd: dir, files: ["**/*.ts"], write: true });
    check();
    assert.equal(
      await readFile(join(dir, "consumer.ts"), "utf8"),
      'import { value } from "@app/utils/value"; export const kept: number = value;\n',
    );
  });

  test("keeps existing loader, query and fragment boundaries", () => {
    for (const [specifier, prefix, path, suffix] of [
      ["#utils", "", "#utils", ""],
      ["#app/utils?raw#fragment", "", "#app/utils", "?raw#fragment"],
      ["loader!#app/utils#fragment", "loader!", "#app/utils", "#fragment"],
      ["!!first!second!./index.mjs?raw#fragment", "!!first!second!", "./index.mjs", "?raw#fragment"],
      ["./index.mjs#fragment", "", "./index.mjs", "#fragment"],
      ["@app/utils?raw", "", "@app/utils", "?raw"],
      ["loader?option!./index.mjs", "", "loader", "?option!./index.mjs"],
    ]) {
      assert.deepEqual(parseSpecifier(specifier), { prefix, path, suffix });
    }
  });
});
