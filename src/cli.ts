#!/usr/bin/env node

import { isAbsolute, relative, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { parseArgs, styleText, type ParseArgsConfig } from "node:util";
import { unbarrelify } from "./main.ts";
import type { Options, ProgressEvent } from "./types.ts";

export interface ParsedArgs {
  only: string[];
  cwd: string;
  files?: string[];
  skip: string[];
  barrel: string[];
  ext?: string;
  write: boolean;
  check: boolean;
  unsafeNamespace: boolean;
  organizeImports: boolean;
  help: boolean;
}

const parseArgsConfig: ParseArgsConfig = {
  options: {
    only: { type: "string", short: "o", multiple: true },
    cwd: { type: "string", short: "c" },
    files: { type: "string", short: "f", multiple: true },
    skip: { type: "string", short: "s", multiple: true },
    barrel: { type: "string", short: "b", multiple: true },
    ext: { type: "string", short: "e" },
    write: { type: "boolean", short: "w" },
    check: { type: "boolean" },
    ci: { type: "boolean" },
    "unsafe-namespace": { type: "boolean" },
    "organize-imports": { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
  allowPositionals: false,
  strict: true,
};

export function parseCliArgs(args: string[]): ParsedArgs {
  const { values } = parseArgs({
    ...parseArgsConfig,
    args,
  }) as {
    values: {
      only?: string[];
      cwd?: string;
      files?: string[];
      skip?: string[];
      barrel?: string[];
      ext?: string;
      write?: boolean;
      check?: boolean;
      ci?: boolean;
      "unsafe-namespace"?: boolean;
      "organize-imports"?: boolean;
      help?: boolean;
    };
  };

  return {
    only: values.only ?? [],
    cwd: values.cwd ?? ".",
    files: values.files,
    skip: values.skip ?? [],
    barrel: values.barrel ?? [],
    ext: values.ext,
    write: values.write ?? false,
    check: values.check ?? values.ci ?? false,
    unsafeNamespace: values["unsafe-namespace"] ?? false,
    organizeImports: values["organize-imports"] ?? false,
    help: values.help ?? false,
  };
}

export function printHelp(): void {
  console.log(`
unbarrelify - Remove barrel files and rewire imports

Usage: unbarrelify [options]

Options:
  -c, --cwd <dir>         Working directory (default: ".")
  -o, --only <file>       Process only selected barrel file (can be repeated)
  -s, --skip <pattern>    Barrel files to skip (glob, can be repeated)
  -b, --barrel <pattern>  Extra files to treat as barrels (glob, can be repeated)
  -f, --files <pattern>   Set file coverage (glob, can be repeated, default: use tsconfig.json)
  -e, --ext <ext>         Extension for rewritten imports (default: auto-detect)
  -w, --write             Write changes to disk (default: false/dry-run)
      --organize-imports  Run TypeScript's "Organize Imports" after rewrites to dedupe imports
      --check, --ci       Check mode for CI; non-zero exit if there are changes
      --unsafe-namespace  Rewrite namespace imports; may include types (bad) and cause identifier collisions (also bad)
  -h, --help              Show this help message

Examples:
  unbarrelify
  unbarrelify --cwd ./src
  unbarrelify --only ./src/utils/index.ts
  unbarrelify --skip ./public-api.ts
  unbarrelify --barrel looks/like/barrel.ts
  unbarrelify --files "src/**/*.ts" --files "lib/**/*.ts"
  unbarrelify --ext .js
  unbarrelify --write
  unbarrelify --check
  unbarrelify --unsafe-namespace
`);
}

export async function main(): Promise<void> {
  let args: ParsedArgs;

  try {
    args = parseCliArgs(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}\n`);
    printHelp();
    process.exit(1);
  }

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  const base = realpathSync(isAbsolute(args.cwd) ? args.cwd : resolve(args.cwd));
  const rel = (p: string) => relative(base, p) || p;

  function handleProgress(event: ProgressEvent): void {
    switch (event.type) {
      case "files":
        console.error(styleText("green", "✔") + ` Found ${event.count} project files`);
        console.error(styleText("green", "✔") + " Processing barrel files and scanning for consumers...");
        break;
      case "barrel":
        console.error(styleText("dim", `    ${rel(event.path)}`));
        break;
      case "rewriting":
        console.error(styleText("green", "✔") + " Scan complete, rewiring imports and deleting barrels...");
        break;
      case "done":
        console.error(styleText("green", "✔") + " Process completed:\n");
        break;
    }
  }

  const options: Options = {
    cwd: args.cwd,
    only: args.only,
    files: args.files,
    skip: args.skip,
    barrel: args.barrel,
    ext: args.ext,
    write: args.write,
    check: args.check,
    unsafeNamespace: args.unsafeNamespace,
    organizeImports: args.organizeImports,
    progress: handleProgress,
  };

  if (args.check) {
    console.error(styleText("cyan", "ℹ") + " Checking\n");
  } else if (!options.write) {
    console.error(styleText("cyan", "ℹ") + " Running in dry-run mode (use --write to apply changes)\n");
  }

  try {
    const result = await unbarrelify(options);

    const skipped = result.preserved.filter((p) => p.reason === "skip");
    const namespace = result.preserved.filter((p) => p.reason === "namespace-import");
    const nonTs = result.preserved.filter((p) => p.reason === "non-ts-import");
    const dynamic = result.preserved.filter((p) => p.reason === "dynamic-import");
    const starReExports = result.preserved.filter((p) => p.reason === "star-reexport");
    const untraceableBarrels = result.preserved.filter((p) => p.reason === "untraceable-import");
    const barrelReExports = result.preserved.filter((p) => p.reason === "barrel-reexport");
    const failedBarrels = result.preserved.filter((p) => p.reason === "consumer-error");

    if (skipped.length > 0) {
      console.error(
        `\n${styleText("cyan", "ℹ")} ${styleText("underline", "Preserved barrel files")} (via --skip, tsconfig#files, or package.json#exports):`,
      );
      for (const { path } of skipped) {
        console.error(`  ${rel(path)}`);
      }
    }

    if (namespace.length > 0) {
      const hint = args.unsafeNamespace ? "" : ", use --unsafe-namespace to rewrite";
      console.error(
        `\n${styleText("cyan", "ℹ")} ${styleText("underline", "Preserved barrel files")} (has namespace imports${hint}):`,
      );
      for (const { path, consumers } of namespace) {
        console.error(`  ${rel(path)}`);
        for (const consumer of consumers ?? []) {
          console.error(`    └─ ${rel(consumer)}`);
        }
      }
    }

    if (nonTs.length > 0) {
      console.error(
        `\n${styleText("cyan", "ℹ")} ${styleText("underline", "Preserved barrel files")} (imports rewritten except for non-JS/TS files):`,
      );
      for (const { path, consumers } of nonTs) {
        console.error(`  ${rel(path)}`);
        for (const consumer of consumers ?? []) {
          console.error(`    └─ ${rel(consumer)}`);
        }
      }
    }

    if (dynamic.length > 0) {
      console.error(
        `\n${styleText("cyan", "ℹ")} ${styleText("underline", "Preserved barrel files")} (rewiring dynamic imports is not supported):`,
      );
      for (const { path, consumers } of dynamic) {
        console.error(`  ${rel(path)}`);
        if (consumers) {
          for (const consumer of consumers) {
            console.error(`    └─ ${rel(consumer)}`);
          }
        }
      }
    }

    if (starReExports.length > 0) {
      console.error(
        `\n${styleText("cyan", "ℹ")} ${styleText("underline", "Preserved barrel files")} (has curated star re-exports that cannot be flattened safely):`,
      );
      for (const { path, consumers } of starReExports) {
        console.error(`  ${rel(path)}`);
        for (const consumer of consumers ?? []) {
          console.error(`    └─ ${rel(consumer)}`);
        }
      }
    }

    if (untraceableBarrels.length > 0) {
      console.error(
        `\n${styleText("cyan", "ℹ")} ${styleText("underline", "Preserved barrel files")} (has untraceable imports, listed below):`,
      );
      for (const { path, consumers } of untraceableBarrels) {
        console.error(`  ${rel(path)}`);
        for (const consumer of consumers ?? []) {
          console.error(`    └─ ${rel(consumer)}`);
        }
      }
    }

    if (barrelReExports.length > 0) {
      console.error(
        `\n${styleText("cyan", "ℹ")} ${styleText("underline", "Preserved barrel files")} (re-exported by preserved barrel files):`,
      );
      for (const { path, consumers } of barrelReExports) {
        console.error(`  ${rel(path)}`);
        for (const consumer of consumers ?? []) {
          console.error(`    └─ ${rel(consumer)}`);
        }
      }
    }

    if (failedBarrels.length > 0) {
      console.error(
        `\n${styleText("cyan", "ℹ")} ${styleText("underline", "Preserved barrel files")} (consumers could not be processed, see errors above):`,
      );
      for (const { path, consumers } of failedBarrels) {
        console.error(`  ${rel(path)}`);
        for (const consumer of consumers ?? []) {
          console.error(`    └─ ${rel(consumer)}`);
        }
      }
    }

    if (result.untraceableImports.length > 0) {
      console.error(`\n${styleText("yellow", "⚠")} Untraceable imports (export not found in barrel or source file):`);
      const grouped = new Map<string, Map<string, string[]>>();
      for (const { barrelPath, consumerPath, name } of result.untraceableImports) {
        let byBarrel = grouped.get(barrelPath);
        if (!byBarrel) {
          byBarrel = new Map();
          grouped.set(barrelPath, byBarrel);
        }
        let names = byBarrel.get(consumerPath);
        if (!names) {
          names = [];
          byBarrel.set(consumerPath, names);
        }
        names.push(name);
      }
      for (const [barrelPath, consumers] of grouped) {
        console.error(`  ${rel(barrelPath)}`);
        for (const [consumerPath, names] of consumers) {
          console.error(`    └─ ${rel(consumerPath)}: ${names.join(", ")}`);
        }
      }
    }

    if (result.exampleDiff && (!options.write || args.check)) {
      console.log(`\n${styleText("cyan", "ℹ")} Largest rewire diff:`);
      console.log(result.exampleDiff);
    }

    console.log(`\n${styleText("green", "✔")} Summary:`);
    console.log(`  Modified ${result.modified.length} file(s)`);
    console.log(`  Deleted ${result.deleted.length} barrel file(s)`);

    if (args.check && (result.modified.length > 0 || result.deleted.length > 0)) {
      console.error(`\n${styleText("red", "✖")} Check failed: changes would be made.`);
    }

    if (!options.write && !args.check && (result.modified.length > 0 || result.deleted.length > 0)) {
      console.error(`\n${styleText("cyan", "ℹ")} Run with --write to apply these changes.`);
    }

    if (args.check && (result.modified.length > 0 || result.deleted.length > 0)) {
      process.exit(1);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    process.exit(1);
  }
}

main();
