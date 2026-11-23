import { basename, dirname, extname, isAbsolute, relative } from "node:path";
import { realpathSync } from "node:fs";
import { ResolverFactory } from "oxc-resolver";
import ts from "typescript";
import type { NapiResolveOptions } from "oxc-resolver";
import { getExtensionFromSpecifier, tryMapToAlias } from "./config.ts";
import type { PathAliases, Rewrite } from "./types.ts";
import { JS_EXT_PATTERN, MODULE_FORMAT_EXTENSIONS, RESOLVER_EXTENSIONS, TS_EXTENSIONS } from "./constants.ts";

const resolverOptions: NapiResolveOptions = {
  tsconfig: "auto",
  extensions: RESOLVER_EXTENSIONS as unknown as string[],
  conditionNames: ["import", "require", "node", "default"],
  extensionAlias: {
    ".js": [".js", ".ts", ".tsx"],
    ".jsx": [".jsx", ".tsx"],
    ".mjs": [".mjs", ".mts"],
    ".cjs": [".cjs", ".cts"],
  },
};

const resolver = new ResolverFactory(resolverOptions);
const projectResolvers = new WeakMap<PathAliases, ResolverFactory>();

const realpathCache = new Map<string, string>();

function cachedRealpath(path: string): string {
  const cached = realpathCache.get(path);
  if (cached) return cached;
  try {
    const real = realpathSync(path);
    realpathCache.set(path, real);
    return real;
  } catch {
    realpathCache.set(path, path);
    return path;
  }
}

function stripQueryString(specifier: string): string {
  const queryIndex = specifier.indexOf("?");
  return queryIndex === -1 ? specifier : specifier.slice(0, queryIndex);
}

// Node's own lookup, from TypeScript: package.json only, no tsconfig paths. Declaration files are hidden so it
// returns the module.
const nodeResolution: ts.CompilerOptions = {
  allowJs: true,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
};
const moduleFiles: ts.ModuleResolutionHost = {
  ...ts.sys,
  fileExists: (path) => !/\.d\.[cm]?ts$/.test(path) && ts.sys.fileExists(path),
};

function resolveLikeNode(fromPath: string, specifier: string): string | undefined {
  const mode = ts.ModuleKind.ESNext;
  return ts.resolveModuleName(specifier, fromPath, nodeResolution, moduleFiles, undefined, undefined, mode)
    .resolvedModule?.resolvedFileName;
}

// Node matches a package-private key as written, `?` and `#` included, while oxc-resolver splits those off first.
function resolvePackageImportKey(fromPath: string, key: string): string | undefined {
  return /^#.*[?#]/.test(key) ? resolveLikeNode(fromPath, key) : undefined;
}

export function isPackageImportKey(fromPath: string, key: string): boolean {
  return resolvePackageImportKey(fromPath, key) !== undefined;
}

export function resolveModule(fromPath: string, specifier: string, aliases: PathAliases | null): string | undefined {
  const cleanSpecifier = stripQueryString(specifier);
  const isRelativeOrAbsolute = cleanSpecifier.startsWith(".") || cleanSpecifier.startsWith("/");

  const resolvedPath =
    resolvePackageImportKey(fromPath, specifier) ??
    resolver.resolveFileSync(fromPath, cleanSpecifier)?.path ??
    resolveWithProjectConfig(fromPath, cleanSpecifier, aliases);

  if (!resolvedPath) {
    return isRelativeOrAbsolute ? undefined : cleanSpecifier;
  }

  if (resolvedPath.includes("node_modules")) {
    return cleanSpecifier;
  }

  return resolvedPath;
}

function resolveWithProjectConfig(
  fromPath: string,
  specifier: string,
  aliases: PathAliases | null,
): string | undefined {
  if (!aliases?.configFile) return undefined;

  let projectResolver = projectResolvers.get(aliases);

  if (!projectResolver) {
    projectResolver = new ResolverFactory({
      ...resolverOptions,
      tsconfig: { configFile: aliases.configFile, references: "auto" },
    });
    projectResolvers.set(aliases, projectResolver);
  }

  return projectResolver.resolveFileSync(fromPath, specifier)?.path;
}

export function ensureExtension(path: string, ext: string | null): string {
  return ext ? path.replace(JS_EXT_PATTERN, ext) : path.replace(JS_EXT_PATTERN, "");
}

interface SpecifierOptions {
  ext?: string | null;
  originalSpecifier?: string;
  packageImportSpecifier?: string;
  packageTargetSpecifier?: string;
  aliases?: PathAliases | null;
}

export function buildSpecifier(from: string, to: string, options: SpecifierOptions = {}): string {
  const { ext, originalSpecifier, aliases, packageImportSpecifier, packageTargetSpecifier } = options;
  const packageKey = packageImportSpecifier ?? (originalSpecifier?.startsWith("#") ? originalSpecifier : undefined);
  if (packageKey) {
    const slash = packageKey.lastIndexOf("/");
    const candidates =
      slash < 0 ? [packageKey] : [packageKey, packageKey.slice(0, slash + 1) + basename(to, extname(to))];
    for (const candidate of candidates) {
      if (resolveModule(from, candidate, aliases ?? null) === to) return candidate;
    }
  }

  if (originalSpecifier && aliases) {
    const aliasSpecifier = tryMapToAlias(to, aliases, originalSpecifier);
    if (aliasSpecifier) {
      const detectedExt = ext !== undefined ? ext : getExtensionFromSpecifier(originalSpecifier);
      const specifier = detectedExt ? ensureExtension(aliasSpecifier, detectedExt) : aliasSpecifier;
      if (resolveModule(from, specifier, aliases) === to) return specifier;
    }
  }

  if (originalSpecifier && !originalSpecifier.startsWith(".") && !originalSpecifier.startsWith("/")) {
    const aliasSpecifier = inferAliasSpecifier(originalSpecifier, to);
    if (aliasSpecifier) {
      const detectedExt = ext !== undefined ? ext : getExtensionFromSpecifier(originalSpecifier);
      const specifier = detectedExt ? ensureExtension(aliasSpecifier, detectedExt) : aliasSpecifier;
      if (resolveModule(from, specifier, aliases ?? null) === to) return specifier;
    }
  }

  const fromDir = dirname(from);
  const realFromDir = cachedRealpath(fromDir);

  let finalExt: string | null;
  if (ext !== undefined) {
    finalExt = ext;
  } else if (originalSpecifier) {
    finalExt =
      getExtensionFromSpecifier(originalSpecifier) ??
      (packageKey ? (packageTargetSpecifier && getExtensionFromSpecifier(packageTargetSpecifier)) || null : null);
  } else {
    finalExt = extname(to) || null;
  }

  const realTo =
    finalExt && TS_EXTENSIONS.has(finalExt)
      ? to
      : ensureExtension(to, MODULE_FORMAT_EXTENSIONS.get(extname(to)) ?? finalExt);
  const relPath = relative(realFromDir, realTo);
  return relPath.startsWith(".") ? relPath : `./${relPath}`;
}

export function buildRewriteSpecifier(
  from: string,
  to: string,
  rewrite: Rewrite,
  options: Pick<SpecifierOptions, "aliases" | "ext">,
): string {
  let base = rewrite.externalSpecifier;
  if (!base || (isAbsolute(to) && !namesFile(from, base, to, options.aliases ?? null))) {
    base = buildSpecifier(from, to, {
      ...options,
      originalSpecifier: rewrite.originalSpecifier,
      packageImportSpecifier: rewrite.packageImportSpecifier,
      packageTargetSpecifier: rewrite.packageTargetSpecifier,
    });
  }
  return (rewrite.specifierPrefix ?? "") + base + (rewrite.specifierSuffix ?? "");
}

// A bare specifier for a local file is kept only where it resolves to that file from the consumer, and Node,
// which ignores tsconfig paths, does not find another file for it.
function namesFile(from: string, specifier: string, to: string, aliases: PathAliases | null): boolean {
  if (resolveModule(from, specifier, aliases) !== to) return false;
  const nodeTarget = resolveLikeNode(from, specifier);
  return nodeTarget === undefined || nodeTarget === to;
}

function inferAliasSpecifier(originalSpecifier: string, targetPath: string): string | null {
  const origParts = originalSpecifier.split("/");
  const targetParts = targetPath.replace(JS_EXT_PATTERN, "").split("/");
  let matchStart = -1;
  for (let i = 0; i < targetParts.length; i++) {
    let matches = true;
    for (let j = 1; j < origParts.length && i + j - 1 < targetParts.length; j++) {
      if (origParts[j] !== targetParts[i + j - 1]) {
        matches = false;
        break;
      }
    }
    if (matches && origParts.length > 1) {
      matchStart = i;
      break;
    }
  }

  if (matchStart === -1) return null;

  const aliasPrefix = origParts[0];
  const remainingTarget = targetParts.slice(matchStart).join("/");

  return aliasPrefix + "/" + remainingTarget;
}
