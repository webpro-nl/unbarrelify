import { dirname, extname, relative } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { realpathSync } from "node:fs";
import ts from "typescript";
import { ResolverFactory } from "oxc-resolver";
import type { NapiResolveOptions } from "oxc-resolver";
import { getExtensionFromSpecifier, tryMapToAlias } from "./config.ts";
import type { PathAliases } from "./types.ts";
import { JS_EXT_PATTERN, RESOLVER_EXTENSIONS } from "./constants.ts";

const resolverOptions: NapiResolveOptions = {
  tsconfig: "auto",
  extensions: RESOLVER_EXTENSIONS as unknown as string[],
  conditionNames: ["import", "module-sync", "node", "default"],
  extensionAlias: {
    ".js": [".js", ".ts", ".tsx"],
    ".jsx": [".jsx", ".tsx"],
    ".mjs": [".mjs", ".mts"],
    ".cjs": [".cjs", ".cts"],
  },
};

const resolver = new ResolverFactory(resolverOptions);
const requireConditions = ["require", "module-sync", "node", "default"];
const requireResolver = new ResolverFactory({ ...resolverOptions, conditionNames: requireConditions });
const packageImportResolver = new ResolverFactory({
  conditionNames: resolverOptions.conditionNames,
  extensions: [],
  mainFiles: [],
  mainFields: [],
  fullySpecified: true,
});
const packageImportSourceResolver = packageImportResolver.cloneWithOptions({
  conditionNames: resolverOptions.conditionNames,
  extensions: [],
  mainFiles: [],
  mainFields: [],
  fullySpecified: true,
  extensionAlias: resolverOptions.extensionAlias,
});
const requirePackageImportResolver = new ResolverFactory({
  conditionNames: requireConditions,
  extensions: [],
  mainFiles: [],
  mainFields: [],
  fullySpecified: true,
});
const requirePackageImportSourceResolver = new ResolverFactory({
  conditionNames: requireConditions,
  extensions: [],
  mainFiles: [],
  mainFields: [],
  fullySpecified: true,
  extensionAlias: resolverOptions.extensionAlias,
});
const projectResolvers = new WeakMap<PathAliases, Map<boolean, ResolverFactory>>();

interface ResolutionCache {
  configPaths: Map<string, string | undefined>;
  configs: Map<string, ts.ParsedCommandLine | undefined>;
  programs: Map<string, ts.Program>;
  formats: Map<string, boolean>;
}

const resolutionCache = new AsyncLocalStorage<ResolutionCache>();

export function withResolutionCache<T>(callback: () => T): T {
  return resolutionCache.run(
    { configPaths: new Map(), configs: new Map(), programs: new Map(), formats: new Map() },
    callback,
  );
}

function usesRequire(fromPath: string, dynamic = false): boolean {
  const cache = resolutionCache.getStore();
  const key = `${dynamic}:${fromPath}`;
  const cached = cache?.formats.get(key);
  if (cached !== undefined) return cached;
  const result = computeUsesRequire(fromPath, dynamic);
  cache?.formats.set(key, result);
  return result;
}

function computeUsesRequire(fromPath: string, dynamic: boolean): boolean {
  if (dynamic && /\.m[jt]s$/.test(fromPath)) return false;
  if (!dynamic && /\.[cm][jt]s$/.test(fromPath)) return /\.c[jt]s$/.test(fromPath);
  const isJavaScript = /\.[cm]?jsx?$/.test(fromPath);
  const cache = resolutionCache.getStore();
  const directory = dirname(fromPath);
  const configFile = cache?.configPaths.has(directory)
    ? cache.configPaths.get(directory)
    : ts.findConfigFile(directory, ts.sys.fileExists);
  cache?.configPaths.set(directory, configFile);
  let options: ts.CompilerOptions | undefined;
  if (configFile) {
    // Reuse config and program only within this public call. Later or concurrent
    // calls get independent state, including changes to extends and imported files.
    let config = cache?.configs.get(configFile);
    if (!cache?.configs.has(configFile)) {
      config = ts.getParsedCommandLineOfConfigFile(
        configFile,
        {},
        { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} },
      );
      cache?.configs.set(configFile, config);
    }
    options = config?.options;
    // These module formats retain import conditions whether or not the file is emitted.
    if (
      options?.module !== undefined &&
      options.module !== ts.ModuleKind.CommonJS &&
      (options.module < ts.ModuleKind.Node16 || options.module === ts.ModuleKind.Preserve)
    ) {
      return false;
    }
    if (config && (isJavaScript || dynamic)) {
      // Only emitted files can change runtime conditions. Imports can include
      // files outside the root include patterns.
      if (
        (isJavaScript && !(options?.allowJs ?? options?.checkJs)) ||
        options?.noEmit ||
        options?.emitDeclarationOnly
      ) {
        options = undefined;
      } else {
        let program = cache?.programs.get(configFile);
        if (!program) {
          program = ts.createProgram(config.fileNames, config.options);
          cache?.programs.set(configFile, program);
        }
        if (!program.getSourceFile(fromPath)) options = undefined;
      }
    }
    if (
      options?.module !== undefined &&
      (options.module < ts.ModuleKind.Node16 || options.module === ts.ModuleKind.Preserve)
    ) {
      return options.module === ts.ModuleKind.CommonJS;
    }
  }
  // CommonJS emit lowers import() to require(); NodeNext, Preserve and raw
  // JavaScript retain import(), even in a CommonJS package.
  if (dynamic) return false;
  // Static import/export in uncompiled JavaScript remains ESM, including Node's
  // syntax detection in packages without type. The analyzer does not route
  // require() calls through this path.
  if (isJavaScript && !options) {
    const content = ts.sys.readFile(fromPath);
    if (content && ts.isExternalModule(ts.createSourceFile(fromPath, content, ts.ScriptTarget.Latest))) {
      return false;
    }
  }
  return (
    ts.getImpliedNodeFormatForFile(fromPath, undefined, ts.sys, {
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
    }) === ts.ModuleKind.CommonJS
  );
}

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

export function resolveModule(
  fromPath: string,
  specifier: string,
  aliases: PathAliases | null,
  dynamic = false,
): string | undefined {
  const cleanSpecifier = stripQueryString(specifier);
  const isRelativeOrAbsolute = cleanSpecifier.startsWith(".") || cleanSpecifier.startsWith("/");

  const require = !isRelativeOrAbsolute && usesRequire(fromPath, dynamic);
  const result = (require ? requireResolver : resolver).resolveFileSync(fromPath, cleanSpecifier);
  const resolvedPath = result?.path ?? resolveWithProjectConfig(fromPath, cleanSpecifier, aliases, require);

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
  require: boolean,
): string | undefined {
  if (!aliases?.configFile) return undefined;

  let resolvers = projectResolvers.get(aliases);
  if (!resolvers) {
    resolvers = new Map();
    projectResolvers.set(aliases, resolvers);
  }
  let projectResolver = resolvers.get(require);

  if (!projectResolver) {
    projectResolver = new ResolverFactory({
      ...resolverOptions,
      conditionNames: require ? requireConditions : resolverOptions.conditionNames,
      tsconfig: { configFile: aliases.configFile, references: "auto" },
    });
    resolvers.set(require, projectResolver);
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
  const require = originalSpecifier?.startsWith("#") ? usesRequire(from) : false;
  const sourceResolver = require ? requirePackageImportSourceResolver : packageImportSourceResolver;
  const runtimeResolver = require ? requirePackageImportResolver : packageImportResolver;
  const packageSource = originalSpecifier?.startsWith("#")
    ? sourceResolver.sync(dirname(from), originalSpecifier).path
    : undefined;
  const isPackageImport = !!packageSource;
  if (ext === undefined && packageSource === to) return originalSpecifier!;
  // A .js package target can resolve to a .ts source before compilation.
  const usesOutputExtension = isPackageImport && !runtimeResolver.sync(dirname(from), originalSpecifier!).path;
  const sourceExt = extname(to);
  const outputExt = usesOutputExtension
    ? ({ ".ts": ".js", ".tsx": ".js", ".mts": ".mjs", ".cts": ".cjs" }[sourceExt] ?? sourceExt)
    : sourceExt;
  const targetPath = ensureExtension(to, ext !== undefined ? ext : outputExt);
  // Package import keys are mappings, so a related spelling need not resolve to the same file.
  const isValidAlias = (specifier: string) =>
    !isPackageImport || runtimeResolver.sync(dirname(from), specifier).path === targetPath;

  if (originalSpecifier && aliases) {
    const aliasSpecifier = tryMapToAlias(to, aliases, originalSpecifier);
    if (aliasSpecifier) {
      const detectedExt = ext !== undefined ? ext : getExtensionFromSpecifier(originalSpecifier);
      const specifier = detectedExt ? ensureExtension(aliasSpecifier, detectedExt) : aliasSpecifier;
      if (isValidAlias(specifier)) return specifier;
    }
  }

  if (originalSpecifier && !originalSpecifier.startsWith(".") && !originalSpecifier.startsWith("/")) {
    const aliasSpecifier = inferAliasSpecifier(originalSpecifier, to);
    if (aliasSpecifier) {
      const detectedExt = ext !== undefined ? ext : getExtensionFromSpecifier(originalSpecifier);
      const specifier = detectedExt ? ensureExtension(aliasSpecifier, detectedExt) : aliasSpecifier;
      if (isValidAlias(specifier)) return specifier;
    }
  }

  const fromDir = dirname(from);
  const realFromDir = cachedRealpath(fromDir);

  let finalExt: string | null;
  if (ext !== undefined) {
    finalExt = ext;
  } else if (originalSpecifier && !isPackageImport) {
    finalExt = getExtensionFromSpecifier(originalSpecifier);
  } else {
    finalExt = outputExt || null;
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
