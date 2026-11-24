import { basename, dirname, extname, isAbsolute, join, relative } from "node:path";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { ResolverFactory } from "oxc-resolver";
import type { NapiResolveOptions } from "oxc-resolver";
import { aliasNamesFile, getExtensionFromSpecifier, tryMapToAlias } from "./config.ts";
import type { PathAliases, Rewrite } from "./types.ts";
import {
  JS_EXT_PATTERN,
  JS_RUNTIME_EXTENSIONS,
  JSX_EXTENSIONS,
  MODULE_FORMAT_EXTENSIONS,
  RESOLVER_EXTENSIONS,
  TS_EXTENSIONS,
} from "./constants.ts";

// The conditions Node applies to an ES module import by default.
const conditionNames = ["node-addons", "node", "import", "module-sync", "default"];

const resolverOptions: NapiResolveOptions = {
  tsconfig: "auto",
  extensions: RESOLVER_EXTENSIONS as unknown as string[],
  conditionNames,
  extensionAlias: {
    ".js": [".js", ".ts", ".tsx"],
    ".jsx": [".jsx", ".tsx"],
    ".mjs": [".mjs", ".mts"],
    ".cjs": [".cjs", ".cts"],
  },
};

const resolver = new ResolverFactory(resolverOptions);
// Package imports as Node resolves them: no tsconfig paths, no extension probing.
const packageImportResolver = new ResolverFactory({ ...resolverOptions, tsconfig: undefined, extensions: [] });
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
// first. A key that contains one is matched against the importer's package.json here, with Node's rules for
// exact keys, patterns and conditions; the resolver then resolves the target like any other file.
function findImportEntry(
  imports: Record<string, unknown>,
  key: string,
): { target: unknown; match: string } | undefined {
  if (Object.hasOwn(imports, key)) return { target: imports[key], match: "" };

  // Node takes the pattern with the longest part before `*`, then the longest pattern.
  let best: { pattern: string; star: number } | undefined;
  for (const pattern of Object.keys(imports)) {
    const star = pattern.indexOf("*");
    if (star < 0 || key.length < pattern.length) continue;
    if (!key.startsWith(pattern.slice(0, star)) || !key.endsWith(pattern.slice(star + 1))) continue;
    if (!best || star > best.star || (star === best.star && pattern.length > best.pattern.length)) {
      best = { pattern, star };
    }
  }
  if (!best) return undefined;

  const trailer = best.pattern.length - best.star - 1;
  return { target: imports[best.pattern], match: key.slice(best.star, key.length - trailer) };
}

// Node rejects a target that leaves the package or names a URL, and goes on to the next entry of an array.
function isValidTarget(target: string): boolean {
  if (!target.startsWith("./")) return !target.startsWith("../") && !target.startsWith("/") && !URL.canParse(target);
  return !target
    .slice(2)
    .split(/[/\\]/)
    .some((segment) => segment === "." || segment === ".." || segment === "node_modules");
}

function selectTarget(target: unknown, match: string): string | undefined {
  if (typeof target === "string") return isValidTarget(target) ? target.replaceAll("*", match) : undefined;
  if (!target || typeof target !== "object") return undefined;

  const candidates = Array.isArray(target)
    ? target
    : Object.entries(target).flatMap(([condition, value]) => (conditionNames.includes(condition) ? [value] : []));
  for (const candidate of candidates) {
    const selected = selectTarget(candidate, match);
    if (selected) return selected;
  }
  return undefined;
}

// A package.json that cannot be read stops the run: its keys decide which barrels a consumer imports.
function readImports(packageJsonPath: string): Record<string, unknown> {
  const content = readFileSync(packageJsonPath, "utf-8");
  try {
    return JSON.parse(content).imports ?? {};
  } catch {
    return {};
  }
}

function isLiteralPackageImportKey(key: string): boolean {
  return /^#.*[?#]/.test(key);
}

function resolvePackageImportKey(fromPath: string, key: string, targetResolver = resolver): string | undefined {
  if (!isLiteralPackageImportKey(key)) return undefined;

  for (let dir = dirname(fromPath); ; dir = dirname(dir)) {
    const packageJsonPath = join(dir, "package.json");
    if (existsSync(packageJsonPath)) {
      const entry = findImportEntry(readImports(packageJsonPath), key);
      if (!entry) return undefined;
      const target = selectTarget(entry.target, entry.match);
      return (target && targetResolver.resolveFileSync(packageJsonPath, target).path) || key;
    }
    if (dir === dirname(dir)) return undefined;
  }
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
  const { ext, originalSpecifier, aliases } = options;
  const keySpecifier = packageKeySpecifier(from, to, options);
  if (keySpecifier) return keySpecifier;

  if (originalSpecifier && aliases) {
    const aliasSpecifier = tryMapToAlias(to, aliases, originalSpecifier);
    if (aliasSpecifier) {
      const detectedExt = ext !== undefined ? ext : getExtensionFromSpecifier(originalSpecifier);
      for (const specifier of aliasCandidates(aliasSpecifier, originalSpecifier, to, detectedExt, aliases)) {
        if (resolvesTo(from, specifier, to, aliases)) return specifier;
      }
    }
  }

  if (originalSpecifier && !originalSpecifier.startsWith(".") && !originalSpecifier.startsWith("/")) {
    const aliasSpecifier = inferAliasSpecifier(originalSpecifier, to);
    if (aliasSpecifier) {
      const detectedExt = ext !== undefined ? ext : getExtensionFromSpecifier(originalSpecifier);
      for (const specifier of aliasCandidates(aliasSpecifier, originalSpecifier, to, detectedExt, aliases)) {
        if (resolvesTo(from, specifier, to, aliases)) return specifier;
      }
    }
  }

  const fromDir = dirname(from);
  const realFromDir = cachedRealpath(fromDir);

  const realTo = ensureExtension(to, specifierExtension(to, specifierStyle(to, options) ?? null));
  const relPath = relative(realFromDir, realTo);
  return relPath.startsWith(".") ? relPath : `./${relPath}`;
}

type StyleOptions = Pick<
  SpecifierOptions,
  "ext" | "originalSpecifier" | "packageImportSpecifier" | "packageTargetSpecifier"
>;

// The extension style of a rewritten specifier: --ext, the consumer's spelling, or the barrel's spelling behind a
// package key. Undefined when only package keys without an extension spell the route, since a key names no file.
function specifierStyle(to: string, options: StyleOptions): string | null | undefined {
  const { ext, originalSpecifier, packageImportSpecifier, packageTargetSpecifier } = options;
  if (ext !== undefined) return ext;
  if (!originalSpecifier) return extname(to) || null;
  const consumerExt = getExtensionFromSpecifier(originalSpecifier);
  const packageKey = packageImportSpecifier ?? (originalSpecifier.startsWith("#") ? originalSpecifier : undefined);
  if (consumerExt || !packageKey) return consumerExt;
  const barrelExt = packageTargetSpecifier && getExtensionFromSpecifier(packageTargetSpecifier);
  if (barrelExt) return barrelExt;
  // A JavaScript target loads as is, so its own extension is safe in any mode.
  if (JS_RUNTIME_EXTENSIONS.has(extname(to))) return extname(to);
  const keysOnly =
    originalSpecifier.startsWith("#") && (!packageTargetSpecifier || packageTargetSpecifier.startsWith("#"));
  return keysOnly ? undefined : null;
}

// A package-private key the consumer can reuse: the barrel's own key, or its wildcard sibling for the target.
function packageKeySpecifier(from: string, to: string, options: SpecifierOptions): string | undefined {
  const { originalSpecifier, packageImportSpecifier, aliases } = options;
  const packageKey = packageImportSpecifier ?? (originalSpecifier?.startsWith("#") ? originalSpecifier : undefined);
  if (!packageKey) return undefined;
  const slash = packageKey.lastIndexOf("/");
  const keyExt = getExtensionFromSpecifier(packageKey) ?? "";
  const candidates =
    slash < 0 ? [packageKey] : [packageKey, packageKey.slice(0, slash + 1) + basename(to, extname(to)) + keyExt];
  return candidates.find((candidate) => resolvesTo(from, candidate, to, aliases));
}

function specifierExtension(target: string, style: string | null): string | null {
  if (!JS_EXT_PATTERN.test(target)) return null;
  const targetExt = extname(target);
  if (style && TS_EXTENSIONS.has(style)) return targetExt;
  const moduleFormat = MODULE_FORMAT_EXTENSIONS.get(targetExt);
  if (moduleFormat) return moduleFormat;
  if (!style) return null;
  return style === ".jsx" && JSX_EXTENSIONS.has(targetExt) ? ".jsx" : ".js";
}

function resolvesTo(from: string, specifier: string, to: string, aliases: PathAliases | null | undefined): boolean {
  // Node resolves a package import from the consumer's package.json alone, whatever tsconfig paths say.
  if (isLiteralPackageImportKey(specifier)) {
    return resolvePackageImportKey(from, specifier, packageImportResolver) === to;
  }
  if (specifier.startsWith("#")) return packageImportResolver.resolveFileSync(from, specifier).path === to;
  return resolveModule(from, specifier, aliases ?? null) === to;
}

function aliasCandidates(
  aliasSpecifier: string,
  originalSpecifier: string,
  to: string,
  style: string | null,
  aliases: PathAliases | null | undefined,
): string[] {
  const ext = specifierExtension(to, style);
  if (!ext) return [aliasSpecifier];
  // Without the extension, the alias is valid where the consumer already uses it or its mapping names the file;
  // elsewhere it relies on extension probing.
  const bare = aliasSpecifier === originalSpecifier || (aliases ? aliasNamesFile(aliasSpecifier, aliases, to) : false);
  return bare ? [aliasSpecifier + ext, aliasSpecifier] : [aliasSpecifier + ext];
}

export function buildRewriteSpecifier(
  from: string,
  to: string,
  rewrite: Rewrite,
  options: Pick<SpecifierOptions, "aliases" | "ext">,
): string {
  let base = rewrite.externalSpecifier;
  if (!base || (isAbsolute(to) && !namesFile(from, base, to, options.aliases ?? null))) {
    base = buildSpecifier(from, to, rewriteSpecifierOptions(rewrite, options));
  }
  return (rewrite.specifierPrefix ?? "") + base + (rewrite.specifierSuffix ?? "");
}

// Whether buildRewriteSpecifier names the target without guessing an import style.
export function canSpellRewrite(
  from: string,
  to: string,
  rewrite: Rewrite,
  options: Pick<SpecifierOptions, "aliases" | "ext">,
): boolean {
  if (!isAbsolute(to)) return true;
  const external = rewrite.externalSpecifier;
  if (external && namesFile(from, external, to, options.aliases ?? null)) return true;
  const specifierOptions = rewriteSpecifierOptions(rewrite, options);
  return (
    packageKeySpecifier(from, to, specifierOptions) !== undefined || specifierStyle(to, specifierOptions) !== undefined
  );
}

function rewriteSpecifierOptions(
  rewrite: Rewrite,
  options: Pick<SpecifierOptions, "aliases" | "ext">,
): SpecifierOptions {
  return {
    ext: options.ext,
    aliases: options.aliases,
    originalSpecifier: rewrite.originalSpecifier,
    packageImportSpecifier: rewrite.packageImportSpecifier,
    packageTargetSpecifier: rewrite.packageTargetSpecifier,
  };
}

// Node looks a package up without tsconfig paths.
const nodeResolver = new ResolverFactory({ ...resolverOptions, tsconfig: undefined });

// A bare specifier for a local file is kept only where it resolves to that file from the consumer. Where Node
// knows the specifier as a package, from the consumer or from the file itself, tsconfig paths are not enough:
// Node has to find the same file for the consumer.
function namesFile(from: string, specifier: string, to: string, aliases: PathAliases | null): boolean {
  if (resolveModule(from, specifier, aliases) !== to) return false;
  const nodeTarget = nodeResolver.resolveFileSync(from, specifier).path;
  return nodeTarget ? nodeTarget === to : nodeResolver.resolveFileSync(to, specifier).path !== to;
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
