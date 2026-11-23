import { basename, dirname, extname, isAbsolute, join, relative } from "node:path";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { ResolverFactory } from "oxc-resolver";
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

// Node matches a package-private key as written, `?` and `#` included, while oxc-resolver splits those off
// first. A key that contains one is therefore read from the importer's package.json.
function findLiteralPackageImport(
  fromPath: string,
  key: string,
): { packageJsonPath: string; target: unknown } | undefined {
  if (!/^#.*[?#]/.test(key)) return undefined;

  for (let dir = dirname(fromPath); ; dir = dirname(dir)) {
    const packageJsonPath = join(dir, "package.json");
    if (existsSync(packageJsonPath)) {
      try {
        const { imports } = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
        return imports && Object.hasOwn(imports, key) ? { packageJsonPath, target: imports[key] } : undefined;
      } catch {
        return undefined;
      }
    }
    if (dir === dirname(dir)) return undefined;
  }
}

export function isPackageImportKey(fromPath: string, key: string): boolean {
  return findLiteralPackageImport(fromPath, key) !== undefined;
}

export function resolveModule(fromPath: string, specifier: string, aliases: PathAliases | null): string | undefined {
  const literal = findLiteralPackageImport(fromPath, specifier);
  if (literal) {
    // Only a plain file target is followed; any other target leaves the import as it is.
    const target =
      typeof literal.target === "string" ? resolveModule(literal.packageJsonPath, literal.target, aliases) : undefined;
    return target && isAbsolute(target) ? target : specifier;
  }

  const cleanSpecifier = stripQueryString(specifier);
  const isRelativeOrAbsolute = cleanSpecifier.startsWith(".") || cleanSpecifier.startsWith("/");

  const result = resolver.resolveFileSync(fromPath, cleanSpecifier);
  const resolvedPath = result?.path ?? resolveWithProjectConfig(fromPath, cleanSpecifier, aliases);

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
  // A bare specifier for a local file is kept only where it resolves to that file from the consumer.
  if (!base || (isAbsolute(to) && resolveModule(from, base, options.aliases ?? null) !== to)) {
    base = buildSpecifier(from, to, {
      ...options,
      originalSpecifier: rewrite.originalSpecifier,
      packageImportSpecifier: rewrite.packageImportSpecifier,
      packageTargetSpecifier: rewrite.packageTargetSpecifier,
    });
  }
  return (rewrite.specifierPrefix ?? "") + base + (rewrite.specifierSuffix ?? "");
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
