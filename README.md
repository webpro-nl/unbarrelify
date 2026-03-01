# unbarrelify

Barrel file removal tool for JavaScript & TypeScript projects (ESM-only).

## What are barrel files?

Barrel files are index files that only contain re-exports from other modules:

```ts
export { formatDate } from "./date.ts";
export { formatCurrency } from "./currency.ts";
export { capitalize } from "./string.ts";
```

## Why avoid barrel files?

Barrel files are convenient, but they often come with trade-offs including:

- Performance and memory: they artificially inflate the module graph and slow down startup times, HMR, and CI pipelines.
- Tree-shaking failures: they often confuse tree-shakers, risk entire libraries to be bundled when only a single function is needed.
- Circular dependencies: they frequently create "import cycles", crashing bundlers or causing confusing errors.

## Resources

- [Speeding up the JavaScript ecosystem - The barrel file debacle][1] (Marvin Hagemeister, 2023-10-08)
- [How we optimized package imports in Next.js][2] (Shu Ding, 2023-10-13)
- [A practical guide against barrel files for library authors][3] (Pascal Schilp, 2024-06-01)
- [Please Stop Using Barrel Files][4] (Dominik Dorfmeister, 2024-07-26)

## Features

- Automated rewiring of consumers to import directly from source
- Preserves path aliases
- Skips barrel files that are entry points (`package.json#exports` etc.)
- Auto-detects or enforces file extensions to match project style
- Optional `--organize-imports` to dedupe and clean up after rewrites
- Granular control with `--skip`, `--only` or add `--barrel`-like files
- Use `--check` for CI to fail if barrel files are detected
- Go all out with `--unsafe-namespace` to namespace imports (warning: naive)
- [Verified on non-trivial repositories][5] to not break the build/tests

## Usage

### Without installation

```sh
npx unbarrelify
npx unbarrelify --help
```

It runs safe in dry-mode until you add `--write`

### Installation

```bash
npm install -D unbarrelify
```

## CLI Usage

```
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
```

## Programmatic API

```ts
import { unbarrelify } from "unbarrelify";

const result = await unbarrelify({
  cwd: "./src",
  files: ["**/*.ts"],
  skip: [],
  ext: ".ts",
  write: false,
});

console.log(`Modified ${result.modified.length} files`);
console.log(`Deleted ${result.deleted.length} barrel files`);
```

### API Reference

#### `unbarrelify(options: Options): Promise<Result>`

The main function that processes files and removes barrel files.

#### `Options`

```ts
interface Options {
  cwd: string;
  only?: string[];
  files?: string[];
  skip?: string[];
  barrel?: string[];
  ext?: string;
  write: boolean;
  check?: boolean;
  unsafeNamespace?: boolean;
  organizeImports?: boolean;
  progress?: (event: ProgressEvent) => void;
}
```

#### `Result`

```ts
interface Result {
  modified: string[];
  deleted: string[];
  preserved: PreservedBarrel[];
}

interface PreservedBarrel {
  path: string;
  reason: "skip" | "namespace-import" | "non-ts-import" | "dynamic-import";
  consumers: string[];
}
```

## How does it work?

1. Identify barrel files (files containing only re-export statements)
2. Build import/export maps to track dependencies
3. Rewire imports in consuming files to point directly to exporting source files
4. Remove barrel files

### Before

```ts
// utils/index.ts
export { formatDate } from "./date.ts";
export { capitalize } from "./string.ts";

// module.ts
import { formatDate, capitalize } from "./utils/index.ts";
```

### After

```ts
// utils/index.ts - DELETED

// module.ts
import { formatDate } from "./utils/date.ts";
import { capitalize } from "./utils/string.ts";
```

## Preserved barrel files

This prevents barrel files from getting deleted:

- File is in `package.json` such as `main` or `exports` field.
- File is `index.*` at root level (of each workspace).
- File is in `--skip` argument.
- Dynamic import calls are not modified, so the imported barrel file is not deleted (e.g. `import("barrel.ts")`).
- Non-JS/TS files are not modified, so the imported barrel file is not deleted (e.g. `*.mdx`).
- Namespace imports are not modified, use `--unsafe-namespace` to rewrite (e.g. `import * as NS from "barrel"`).

The output in CLI prints "Preserved barrel files" with details.

## License

ISC

[1]: https://marvinh.dev/blog/speeding-up-javascript-ecosystem-part-7/
[2]: https://vercel.com/blog/how-we-optimized-package-imports-in-next-js
[3]: https://dev.to/thepassle/a-practical-guide-against-barrel-files-for-library-authors-118c
[4]: https://tkdodo.eu/blog/please-stop-using-barrel-files
[5]: https://github.com/webpro/unbarrelify/blob/main/.github/workflows/integration.yml
