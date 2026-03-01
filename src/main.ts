import { isAbsolute, relative, resolve } from "node:path";
import { readFile, realpath, unlink, writeFile } from "node:fs/promises";
import { styleText } from "node:util";
import { glob } from "tinyglobby";
import ts from "typescript";
import { analyzeFile, buildExportMap, checkIsBarrel, parseSpecifier } from "./analyzer.ts";
import { initProjectConfig } from "./config.ts";
import { extractImportLine, formatExampleDiff, type ExampleCandidate } from "./diff.ts";
import { resolveModule } from "./resolver.ts";
import { applyRewrites, buildRewrites, type RewriteContext } from "./rewriter.ts";
import { BarrelTracker } from "./tracker.ts";
import type { Context, File, Options, Result, Rewrites } from "./types.ts";
import { DEFAULT_GLOBS, isIgnoredPath } from "./constants.ts";

function detectSingleQuote(sourceFile: ts.SourceFile): boolean {
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const specStart = statement.moduleSpecifier.getStart(sourceFile);
      return sourceFile.text[specStart] === "'";
    }
  }
  return false;
}

const DEFAULT_IGNORE = ["**/node_modules/**", "**/dist/**", "**/build/**", "**/out/**", "**/coverage/**", "**/*.d.ts"];

async function read(filePath: string): Promise<string> {
  return readFile(filePath, "utf-8");
}

async function write(filePath: string, content: string): Promise<void> {
  return writeFile(filePath, content, "utf-8");
}

export async function unbarrelify(options: Options): Promise<Result> {
  const ctx = await createContext(options);
  const files = await getProjectFiles(options.files, ctx);

  ctx.progress({ type: "files", count: files.length });

  if (ctx.only.length > 0) {
    await registerExplicitBarrels(ctx.only, ctx);
  }

  return processFiles(files, ctx);
}

async function createContext(options: Options): Promise<Context> {
  const {
    cwd,
    only = [],
    skip = [],
    barrel = [],
    ext,
    write,
    check = false,
    unsafeNamespace = false,
    organizeImports = false,
    progress = () => {},
  } = options;
  const base = await realpath(isAbsolute(cwd) ? cwd : resolve(cwd));
  const project = initProjectConfig(base);

  const includedBarrels: Set<string> =
    barrel.length > 0
      ? new Set(await glob(barrel, { cwd: base, onlyFiles: true, absolute: true, dot: false }))
      : new Set();

  const skipPatterns = await glob(skip, { cwd: base, onlyFiles: true, absolute: true, dot: false });
  const preservedBarrels = new Set(skipPatterns);

  const tracker = new BarrelTracker();

  const ctx: Context = {
    base,
    only,
    ext,
    write,
    check,
    unsafeNamespace,
    organizeImports,
    aliases: project.aliases,
    projectFiles: project.files,
    preservedBarrels,
    includedBarrels,
    fileCache: new Map<string, File>(),
    isPackageEntryPoint: project.isPackageEntryPoint,
    progress,
    tracker,
  };

  return ctx;
}

async function registerExplicitBarrels(paths: string[], ctx: Context): Promise<void> {
  const rel = (p: string) => relative(ctx.base, p);

  for (const path of paths) {
    const barrelPath = isAbsolute(path) ? path : resolve(ctx.base, path);
    const content = await read(barrelPath);
    const sourceFile = ts.createSourceFile(barrelPath, content, ts.ScriptTarget.Latest);
    const isBarrelFile = checkIsBarrel(sourceFile) || ctx.includedBarrels.has(barrelPath);

    if (!isBarrelFile) {
      console.log(`File is not a barrel: ${rel(barrelPath)}`);
      continue;
    }

    if (ctx.preservedBarrels.has(barrelPath) || ctx.isPackageEntryPoint(barrelPath)) {
      console.log(`File is in skip list: ${rel(barrelPath)}`);
      continue;
    }

    ctx.fileCache.set(barrelPath, {
      isBarrel: true,
      imports: new Map(),
      exports: await buildExportMap(sourceFile, ctx.aliases),
      sourceFile,
      dynamicImports: new Set(),
    });

    ctx.tracker.register(barrelPath);
    ctx.progress({ type: "barrel", path: barrelPath });
  }
}

async function getProjectFiles(patterns: string[] | undefined, ctx: Context): Promise<string[]> {
  if (patterns) {
    return glob(patterns, {
      cwd: ctx.base,
      onlyFiles: true,
      absolute: true,
      ignore: DEFAULT_IGNORE,
      expandDirectories: false,
      dot: false,
    });
  }

  const relevantFiles = ctx.projectFiles.filter((f) => f.startsWith(ctx.base + "/") && !isIgnoredPath(f, ctx.base));
  if (relevantFiles.length > 0) {
    return relevantFiles;
  }

  return glob(DEFAULT_GLOBS, {
    cwd: ctx.base,
    onlyFiles: true,
    absolute: true,
    ignore: DEFAULT_IGNORE,
    expandDirectories: false,
    dot: false,
  });
}

async function processFiles(files: string[], ctx: Context): Promise<Result> {
  const rel = (p: string) => relative(ctx.base, p);
  const baseRewriteContext: RewriteContext = {
    ext: ctx.ext,
    aliases: ctx.aliases,
    organizeImports: ctx.organizeImports,
  };

  const modified: string[] = [];
  const errors: Array<{ file: string; error: Error }> = [];
  let bestExample: ExampleCandidate | null = null;

  const total = files.length;
  for (let i = 0; i < total; i++) {
    const filePath = files[i];
    if (ctx.only.length > 0 && ctx.tracker.has(filePath)) continue;

    ctx.progress({ type: "scanning", current: i + 1, total });

    try {
      const analysis = await analyzeFile(filePath, ctx);
      if (!analysis.sourceFile) continue;

      if (ctx.only.length === 0) {
        await discoverBarrels(analysis, filePath, ctx);
      }

      const rewrites = await buildRewrites(analysis, filePath, ctx);
      if (rewrites.size === 0) continue;

      markRewrittenBarrels(analysis, filePath, rewrites, ctx);

      const rewriteContext = { ...baseRewriteContext, singleQuote: detectSingleQuote(analysis.sourceFile) };
      const content = applyRewrites(analysis.sourceFile, rewrites, filePath, rewriteContext);

      if (!ctx.write || ctx.check) {
        bestExample = pickBestExample(rewrites, analysis.sourceFile, filePath, bestExample);
      }

      if (ctx.write && !ctx.check) {
        await write(filePath, content);
      }
      modified.push(filePath);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error(`Error processing ${rel(filePath)}:`, err.message);
      errors.push({ file: filePath, error: err });
    }
  }

  ctx.progress({ type: "rewriting" });

  if (ctx.only.length === 0) {
    await trackNonTsConsumers(ctx);
  }

  ctx.progress({ type: "done" });

  const { deleted, preserved } = ctx.tracker.classify(ctx);

  if (modified.length > 0) {
    console.log(modified.map((p) => `${styleText("yellow", "modified:")} ${rel(p)}`).join("\n"));
  }
  if (deleted.length > 0) {
    console.log(deleted.map((p) => `${styleText("red", "deleted:")} ${rel(p)}`).join("\n"));
  }

  for (const barrelPath of deleted) {
    if (ctx.write && !ctx.check) {
      try {
        await unlink(barrelPath);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        console.error(`Error deleting ${barrelPath}:`, err.message);
        errors.push({ file: barrelPath, error: err });
      }
    }
  }

  if (errors.length > 0) {
    console.error(`\nEncountered ${errors.length} error(s) during processing:`);
    for (const { file, error } of errors) {
      console.error(`  - ${file}: ${error.message}`);
    }
  }

  const exampleDiff = bestExample
    ? formatExampleDiff(bestExample.original, bestExample.targetMap, bestExample.filePath, baseRewriteContext)
    : undefined;

  return { modified, deleted, preserved, untraceableImports: ctx.tracker.untraceableImports, exampleDiff };
}

export function isBarrel(filePath: string, analysis: File, ctx: Context): boolean {
  return analysis.isBarrel || ctx.includedBarrels.has(filePath);
}

async function discoverBarrels(analysis: File, consumerPath: string, ctx: Context): Promise<void> {
  if (analysis.isBarrel && ctx.isPackageEntryPoint(consumerPath)) {
    if (ctx.tracker.register(consumerPath)) {
      ctx.progress({ type: "barrel", path: consumerPath });
    }
  }

  if (ctx.includedBarrels.has(consumerPath)) {
    if (ctx.tracker.register(consumerPath)) {
      ctx.progress({ type: "barrel", path: consumerPath });
    }
  }

  for (const dynamicImport of analysis.dynamicImports) {
    const imported = await analyzeFile(dynamicImport, ctx);
    if (isBarrel(dynamicImport, imported, ctx)) {
      ctx.tracker.register(dynamicImport);
      ctx.tracker.addDynamicConsumer(dynamicImport, consumerPath);
      ctx.progress({ type: "barrel", path: dynamicImport });
    }
  }

  for (const [importedFilePath] of analysis.imports) {
    if (!isAbsolute(importedFilePath)) continue;
    if (isIgnoredPath(importedFilePath, ctx.base)) continue;

    const importedFile = await analyzeFile(importedFilePath, ctx);
    if (isBarrel(importedFilePath, importedFile, ctx)) {
      if (ctx.tracker.register(importedFilePath)) {
        ctx.progress({ type: "barrel", path: importedFilePath });
      }
      ctx.tracker.addConsumer(importedFilePath, consumerPath);
      if (analysis.isBarrel) {
        ctx.tracker.register(consumerPath);
      }
    }
  }
}

function markRewrittenBarrels(analysis: File, consumerPath: string, rewrites: Rewrites, ctx: Context): void {
  const rewrittenPositions = new Set(rewrites.keys());

  for (const [importedFilePath, importSet] of analysis.imports) {
    if (!isAbsolute(importedFilePath)) continue;
    if (isIgnoredPath(importedFilePath, ctx.base)) continue;

    const cached = ctx.fileCache.get(importedFilePath);
    if (cached && isBarrel(importedFilePath, cached, ctx) && ctx.tracker.has(importedFilePath)) {
      for (const item of importSet) {
        const posKey = `${item.pos.start}:${item.pos.end}`;
        if (rewrittenPositions.has(posKey)) {
          ctx.tracker.markRewritten(importedFilePath, consumerPath);
          break;
        }
      }
    }
  }
}

function pickBestExample(
  rewrites: Rewrites,
  sourceFile: ts.SourceFile,
  filePath: string,
  current: ExampleCandidate | null,
): ExampleCandidate | null {
  for (const [posKey, targetMap] of rewrites) {
    if (targetMap.size > (current?.targetMap.size ?? 0)) {
      const [start, end] = posKey.split(":").map(Number);
      const original = extractImportLine(sourceFile.text.slice(start, end));
      return { original, targetMap, filePath };
    }
  }
  return current;
}

const IMPORT_PATTERN = /(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g;
const NON_TS_FILE_GLOB = "**/*.{astro,html,marko,mdx,svelte,vue}";

async function trackNonTsConsumers(ctx: Context): Promise<void> {
  const nonTsFiles = await glob(NON_TS_FILE_GLOB, {
    cwd: ctx.base,
    onlyFiles: true,
    absolute: true,
    ignore: DEFAULT_IGNORE,
    dot: false,
  });

  for (const nonTsFile of nonTsFiles) {
    try {
      const content = await readFile(nonTsFile, "utf-8");

      for (const match of content.matchAll(IMPORT_PATTERN)) {
        const rawSpecifier = match[1];
        const { path: specifier } = parseSpecifier(rawSpecifier);

        const resolved = resolveModule(nonTsFile, specifier, ctx.aliases);
        if (!resolved || !resolved.startsWith(ctx.base)) continue;

        if (ctx.tracker.has(resolved)) {
          ctx.tracker.addConsumer(resolved, nonTsFile);
        } else {
          const analysis = await analyzeFile(resolved, ctx);
          if (isBarrel(resolved, analysis, ctx)) {
            ctx.tracker.register(resolved);
            ctx.tracker.addConsumer(resolved, nonTsFile);
          }
        }
      }
    } catch {
      // Ignore read errors
    }
  }
}
