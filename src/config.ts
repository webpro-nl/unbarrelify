import { dirname, join, resolve } from "node:path";
import { existsSync } from "node:fs";
import ts from "typescript";
import type { PathAliases } from "./types.ts";
import { JS_EXT_PATTERN } from "./constants.ts";
import { createEntryPointChecker } from "./entry.ts";

interface ProjectConfig {
  aliases: PathAliases | null;
  files: string[];
  explicitFiles: string[];
  isPackageEntryPoint: (filePath: string) => boolean;
}

export function initProjectConfig(cwd: string): ProjectConfig {
  const tsconfigPath = findTsConfig(cwd);
  const graph = tsconfigPath ? parseTsConfigGraph(tsconfigPath) : null;
  const parsed = graph?.root ?? null;
  const tsconfigDir = tsconfigPath ? dirname(tsconfigPath) : null;

  const aliases = parsed && tsconfigDir && tsconfigPath ? extractPathAliases(parsed, tsconfigDir, tsconfigPath) : null;
  const files = graph?.files ?? [];
  const explicitFiles = graph?.explicitFiles ?? [];
  const isPackageEntryPoint = createEntryPointChecker();

  return { aliases, files, explicitFiles, isPackageEntryPoint };
}

function findTsConfig(startDir: string): string | null {
  let dir = startDir;
  while (dir !== dirname(dir)) {
    const tsconfigPath = join(dir, "tsconfig.json");
    if (existsSync(tsconfigPath)) return tsconfigPath;
    dir = dirname(dir);
  }
  return null;
}

interface TsConfigGraph {
  root: ts.ParsedCommandLine;
  files: string[];
  explicitFiles: string[];
}

function parseTsConfigGraph(tsconfigPath: string): TsConfigGraph | null {
  const visited = new Set<string>();
  const files = new Set<string>();
  const explicitFiles = new Set<string>();
  let root: ts.ParsedCommandLine | null = null;

  function visit(configPath: string): void {
    const normalizedPath = resolve(configPath);
    if (visited.has(normalizedPath)) return;
    visited.add(normalizedPath);

    const parsed = parseTsConfigFile(normalizedPath);
    if (!parsed) return;
    root ??= parsed;

    for (const file of parsed.fileNames) files.add(file);
    for (const file of parsed.raw?.files ?? []) {
      if (typeof file === "string") explicitFiles.add(resolve(dirname(normalizedPath), file));
    }
    for (const reference of parsed.projectReferences ?? []) {
      visit(ts.resolveProjectReferencePath(reference));
    }
  }

  visit(tsconfigPath);
  return root ? { root, files: [...files], explicitFiles: [...explicitFiles] } : null;
}

function parseTsConfigFile(tsconfigPath: string): ts.ParsedCommandLine | null {
  const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (configFile.error) return null;

  return ts.parseJsonConfigFileContent(configFile.config, ts.sys, dirname(tsconfigPath));
}

function extractPathAliases(
  parsed: ts.ParsedCommandLine,
  tsconfigDir: string,
  tsconfigPath: string,
): PathAliases | null {
  const paths = parsed.options.paths;
  if (!paths) return null;

  return {
    baseUrl: parsed.options.baseUrl ?? tsconfigDir,
    configFile: tsconfigPath,
    paths,
  };
}

export function getExtensionFromSpecifier(specifier: string): string | null {
  const match = specifier.match(JS_EXT_PATTERN);
  return match ? match[0] : null;
}

export function tryMapToAlias(absolutePath: string, aliases: PathAliases, originalSpecifier: string): string | null {
  const originalUsedAlias = !originalSpecifier.startsWith(".") && !originalSpecifier.startsWith("/");
  if (!originalUsedAlias) return null;

  const sortedPatterns = Object.entries(aliases.paths).sort((a, b) => {
    const aPrefix = a[0].replace(/\*.*$/, "");
    const bPrefix = b[0].replace(/\*.*$/, "");
    return bPrefix.length - aPrefix.length;
  });

  for (const [pattern, targets] of sortedPatterns) {
    const patternRegex = new RegExp(`^${pattern.replace(/\*/g, "(.*)")}$`);
    const match = originalSpecifier.match(patternRegex);

    if ((match || pattern === `${originalSpecifier}/*`) && targets.length > 0) {
      const targetPattern = targets[0];
      const targetBase = targetPattern.replace(/\*.*$/, "");
      const resolvedTargetBase = join(aliases.baseUrl, targetBase);

      if (absolutePath.startsWith(resolvedTargetBase)) {
        const relativePart = absolutePath.slice(resolvedTargetBase.length);
        const withoutExt = relativePart.replace(JS_EXT_PATTERN, "");
        // An exact alias can name this file, but cannot accept a suffix.
        if (!pattern.includes("*") && withoutExt) continue;
        const aliasBase = pattern.replace(/\*.*$/, "");
        return aliasBase + withoutExt;
      }
    }
  }

  return null;
}
