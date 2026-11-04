import { dirname, extname, relative } from "node:path";
import { realpathSync } from "node:fs";
import { ResolverFactory } from "oxc-resolver";
import type { NapiResolveOptions } from "oxc-resolver";
import { getExtensionFromSpecifier, tryMapToAlias } from "./config.ts";
import type { PathAliases } from "./types.ts";
import { JS_EXT_PATTERN, RESOLVER_EXTENSIONS } from "./constants.ts";

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

export function resolveModule(fromPath: string, specifier: string, aliases: PathAliases | null): string | undefined {
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
  aliases?: PathAliases | null;
}

export function buildSpecifier(from: string, to: string, options: SpecifierOptions = {}): string {
  const { ext, originalSpecifier, aliases } = options;

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
    finalExt = getExtensionFromSpecifier(originalSpecifier);
  } else {
    finalExt = extname(to) || null;
  }

  const realTo = ensureExtension(to, finalExt);
  const relPath = relative(realFromDir, realTo);
  return relPath.startsWith(".") ? relPath : `./${relPath}`;
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
