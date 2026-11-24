import { isAbsolute } from "node:path";
import type ts from "typescript";
import { analyzeFile } from "./analyzer.ts";
import {
  createImportDeclaration,
  createNsImportDeclaration,
  createReExportDeclaration,
  createUnsafeNamespaceDeclaration,
} from "./factory.ts";
import { isBarrel } from "./main.ts";
import { organizeImports } from "./organize.ts";
import { printNode } from "./printer.ts";
import { buildRewriteSpecifier, canSpellRewrite } from "./resolver.ts";
import type {
  Context,
  ExportData,
  ExportMap,
  File,
  ImportData,
  Name,
  PathAliases,
  Rewrite,
  Rewrites,
  RewritesByPosition,
} from "./types.ts";
import { isIgnoredPath } from "./constants.ts";

export interface RewriteContext {
  ext?: string;
  aliases?: PathAliases | null;
  organizeImports?: boolean;
  singleQuote?: boolean;
}

// The spellings a rewrite may reuse: the barrel's own package-private key, and the style of its target
// when the consumer reached the barrel through such a key.
function packageSpecifiers(importItem: ImportData, exportItem: ExportData) {
  return {
    packageTargetSpecifier: importItem.originalSpecifier?.startsWith("#") ? exportItem.specifier : undefined,
    packageImportSpecifier: exportItem.specifier.startsWith("#") ? exportItem.specifier : undefined,
  };
}

export function buildRewriteItem(
  name: Name,
  importItem: ImportData,
  exportItem: ExportData,
  isNamespace = false,
): Rewrite {
  const isDefault = name.name === "default";
  const isReExport = importItem.type === "export";
  // A default import cannot carry a `type` modifier next to other names, so a type-only default is imported
  // as `default as`.
  const isNamedDefault = isDefault && (isReExport || Boolean(name.isType));
  const localName = name.alias ?? importItem.name;
  return {
    type: isReExport ? "export" : "import",
    ns: isDefault ? undefined : importItem.name,
    named: isNamedDefault ? [{ ...name, alias: localName }] : isDefault ? [] : [name],
    members: importItem.type === "ns" && !isDefault ? [{ name: name.name }] : [],
    externalSpecifier: exportItem.externalSpecifier,
    reExportedNs: isNamespace ? (name.alias ?? name.name) : undefined,
    isTypeOnly: isNamespace && name.isType ? true : undefined,
    defaultName: isDefault && !isNamedDefault ? localName : undefined,
    originalSpecifier: importItem.originalSpecifier,
    ...packageSpecifiers(importItem, exportItem),
    specifierPrefix: importItem.specifierPrefix,
    specifierSuffix: importItem.specifierSuffix,
  };
}

export function reverseRewritesByPos(rewrites: Rewrites): RewritesByPosition {
  return [...rewrites.entries()]
    .map(([pos, item]) => {
      const [start, end] = pos.split(":").map(Number) as [number, number];
      return [[start, end], item] as RewritesByPosition[number];
    })
    .sort((a, b) => b[0][0] - a[0][0]);
}

export function applyRewrites(
  sourceFile: ts.SourceFile,
  rewrites: Rewrites,
  filePath: string,
  ctx: RewriteContext = {},
): string {
  let content = sourceFile.text;
  const singleQuote = ctx.singleQuote ?? false;

  for (const [[start, end], rewriteMap] of reverseRewritesByPos(rewrites)) {
    const replacements: string[] = [];
    let unsafeNsName: string | undefined;
    const unsafeNsIdentifiers: string[] = [];

    for (const [targetFilePath, rewrite] of rewriteMap) {
      const specifier = buildRewriteSpecifier(filePath, targetFilePath, rewrite, ctx);

      if (rewrite.unsafeNsName) {
        unsafeNsName = rewrite.unsafeNsName;
        for (const name of rewrite.named) {
          unsafeNsIdentifiers.push(name.alias ?? name.name);
        }
      }

      if (rewrite.reExportedNs) {
        replacements.push(
          printNode(
            createNsImportDeclaration(specifier, rewrite.reExportedNs, singleQuote, rewrite.isTypeOnly),
            sourceFile,
          ),
        );
      } else if (rewrite.type === "import") {
        replacements.push(printNode(createImportDeclaration(rewrite, specifier, singleQuote), sourceFile));
      } else {
        replacements.push(printNode(createReExportDeclaration(rewrite, specifier, singleQuote), sourceFile));
      }
    }

    if (unsafeNsName && unsafeNsIdentifiers.length > 0) {
      replacements.push(printNode(createUnsafeNamespaceDeclaration(unsafeNsName, unsafeNsIdentifiers), sourceFile));
    }

    const replacement = replacements.join("\n");
    content = content.slice(0, start) + replacement + content.slice(end);
  }

  return ctx.organizeImports ? organizeImports(content, filePath) : content;
}

function isNameExported(name: Name, exportItem: ExportData): boolean {
  if (exportItem.reExportedNs?.has(name.name)) return true;
  if (exportItem.exportedNames.size === 0) {
    return !!exportItem.externalSpecifier;
  }
  if (exportItem.exportedNames.has(name.name)) return true;
  if (exportItem.aliases?.has(name.name)) return true;
  return false;
}

function addRewrite(
  name: Name,
  importItem: ImportData,
  exportItem: ExportData,
  targetFilePath: string,
  rewrites: Rewrites,
  added: Set<string>,
  isNamespace = false,
): boolean {
  const pos = `${importItem.pos.start}:${importItem.pos.end}`;
  const nameKey = `${pos}:${name.name}:${name.alias ?? ""}`;
  if (added.has(nameKey)) return false;

  let posRewrites = rewrites.get(pos);
  if (!posRewrites) {
    posRewrites = new Map();
    rewrites.set(pos, posRewrites);
  }

  const item = buildRewriteItem(name, importItem, exportItem, isNamespace);
  const existing = posRewrites.get(targetFilePath);
  // A rewrite is either a namespace import or named imports, so one declaration cannot take both from a target.
  if (existing && existing.reExportedNs !== item.reExportedNs) return false;
  added.add(nameKey);

  if (!existing) {
    posRewrites.set(targetFilePath, item);
  } else if (importItem.type === "ns") {
    existing.members.push({ name: name.name });
  } else {
    existing.named.push(name);
  }

  return true;
}

// The names behind `export *` from a package are unknown, so such an export is used only when
// nothing else exports the name and it is the only candidate.
type PackageStars = Map<string, () => boolean>;

function usePackageStar(packageStars: PackageStars): boolean {
  return packageStars.size === 1 && [...packageStars.values()][0]();
}

async function traceName(
  name: Name,
  importItem: ImportData,
  exports: ExportMap | undefined,
  rewrites: Rewrites,
  ctx: Context,
  added: Set<string>,
): Promise<boolean> {
  const packageStars: PackageStars = new Map();
  const found = await traceExport(name, importItem, exports, rewrites, ctx, added, new Set(), packageStars);
  return found ?? usePackageStar(packageStars);
}

// Resolves to `undefined` when the name is not found here and another export may still provide it.
async function traceExport(
  name: Name,
  importItem: ImportData,
  exports: ExportMap | undefined,
  rewrites: Rewrites,
  ctx: Context,
  added: Set<string>,
  visited: Set<string>,
  packageStars: PackageStars,
): Promise<boolean | undefined> {
  if (!exports) return undefined;

  // A named or namespace re-export is the only route to its name, whatever the order: no other export is tried
  // after it, and only the package stars behind it count.
  const isNamed = (exportItem: ExportData) =>
    Boolean(exportItem.reExportedNs?.has(name.name) || exportItem.namedExports?.has(name.name));
  const byNamedFirst = [...exports].sort(([, a], [, b]) => Number(isNamed(b)) - Number(isNamed(a)));

  for (const [targetFilePath, exportItem] of byNamedFirst) {
    const isExported = isNameExported(name, exportItem);
    if (!isExported && !exportItem.exportStar) continue;
    // Decided on the name as requested: after alias translation it can spell a namespace of the same target.
    const isNamespace = exportItem.reExportedNs?.has(name.name) ?? false;

    const alias = exportItem.aliases?.get(name.name);
    let effectiveName: Name;

    if (name.name === "default" && exportItem.exportedAsDefault) {
      const localName = name.alias ?? importItem.name;
      effectiveName = {
        name: exportItem.exportedAsDefault,
        alias: localName === exportItem.exportedAsDefault ? undefined : localName,
        isType: name.isType,
      };
    } else if (alias) {
      effectiveName = { name: alias, alias: name.alias ?? name.name, isType: name.isType };
    } else {
      effectiveName = name;
    }

    const stars: PackageStars = isNamed(exportItem) ? new Map() : packageStars;
    const external = isAbsolute(targetFilePath) ? exportItem.externalSpecifier : targetFilePath;

    if (external) {
      // A package-private key without a local target cannot be copied to another file. Its exports still count,
      // so the names it provides or may provide are not taken from elsewhere.
      const isMovable = !external.startsWith("#");
      const target = isAbsolute(targetFilePath) ? targetFilePath : external;
      if (exportItem.exportedNames.has(name.name) || isNamespace) {
        if (isMovable && addRewrite(effectiveName, importItem, exportItem, target, rewrites, added, isNamespace)) {
          return true;
        }
      } else if (exportItem.exportStar && (!isAbsolute(targetFilePath) || exportItem.exportedNames.size === 0)) {
        packageStars.set(
          external,
          () => isMovable && addRewrite(name, importItem, exportItem, target, rewrites, added),
        );
      }
    } else if (!isIgnoredPath(targetFilePath, ctx.base)) {
      const targetFile = await analyzeFile(targetFilePath, ctx);

      if (!targetFile.isBarrel) {
        if (
          isExported &&
          addRewrite(effectiveName, importItem, exportItem, targetFilePath, rewrites, added, isNamespace)
        ) {
          return true;
        }
      } else if (ctx.only.length === 0) {
        ctx.tracker.register(targetFilePath);
      }

      const visitKey = `${targetFilePath}:${effectiveName.name}:${effectiveName.alias ?? ""}`;
      if (visited.has(visitKey)) {
        if (isNamed(exportItem)) return undefined;
        continue;
      }
      visited.add(visitKey);
      const found = await traceExport(
        effectiveName,
        importItem,
        targetFile.exports,
        rewrites,
        ctx,
        added,
        visited,
        stars,
      );
      if (found !== undefined) return found;
    }

    if (isNamed(exportItem)) return usePackageStar(stars);
  }

  return undefined;
}

export async function buildRewrites(analysis: File, filePath: string, ctx: Context): Promise<Rewrites> {
  const rewrites: Rewrites = new Map();
  const added = new Set<string>();
  const unchanged = new Set<string>();
  if (analysis.isBarrel && !ctx.preservedBarrels.has(filePath) && !ctx.isPackageEntryPoint(filePath)) return rewrites;

  for (const [importedFilePath, importSet] of analysis.imports) {
    if (!isAbsolute(importedFilePath)) continue;
    if (isIgnoredPath(importedFilePath, ctx.base)) continue;
    if (ctx.preservedBarrels.has(importedFilePath) || ctx.isPackageEntryPoint(importedFilePath)) continue;

    if (ctx.only.length > 0) {
      if (!ctx.tracker.has(importedFilePath)) continue;
    } else {
      const importedFile = await analyzeFile(importedFilePath, ctx);
      if (!isBarrel(importedFilePath, importedFile, ctx)) continue;
      ctx.tracker.register(importedFilePath);
    }

    const importedFile = await analyzeFile(importedFilePath, ctx);

    for (const item of importSet) {
      if (!item) continue;

      if (
        item.type === "ns" &&
        [...importSet].some((other) => other.type === "default" && other.pos.start === item.pos.start)
      ) {
        unchanged.add(`${item.pos.start}:${item.pos.end}`);
        continue;
      }

      for (const name of item.names ?? []) {
        const found = await traceName(name, item, importedFile.exports, rewrites, ctx, added);
        if (!found) {
          unchanged.add(`${item.pos.start}:${item.pos.end}`);
          ctx.tracker.untraceableImports.push({
            barrelPath: importedFilePath,
            consumerPath: filePath,
            name: name.name,
          });
        }
      }

      for (const member of item.members ?? []) {
        await traceName(member, item, importedFile.exports, rewrites, ctx, added);
      }

      if (item.type === "default") {
        const name = { name: "default", isType: item.isTypeOnly };
        const found = await traceName(name, item, importedFile.exports, rewrites, ctx, added);
        if (!found) {
          unchanged.add(`${item.pos.start}:${item.pos.end}`);
          ctx.tracker.untraceableImports.push({
            barrelPath: importedFilePath,
            consumerPath: filePath,
            name: "default",
          });
        }
      }

      if (item.type === "ns" && item.name && !item.members?.length) {
        const localExports = [...importedFile.exports.entries()].filter(([path]) => isAbsolute(path));
        if (localExports.length === 1) {
          const [targetPath, exportData] = localExports[0];
          const targetFile = await analyzeFile(targetPath, ctx);

          let finalPath = targetPath;
          if (targetFile.isBarrel) {
            const deepLocalExports = [...targetFile.exports.entries()].filter(([p]) => isAbsolute(p));
            if (deepLocalExports.length === 1) finalPath = deepLocalExports[0][0];
          }
          const finalIsBarrel = isBarrel(finalPath, await analyzeFile(finalPath, ctx), ctx);
          if (!finalIsBarrel && (exportData.exportedNames.size > 0 || exportData.externalSpecifier)) {
            addRewrite({ name: item.name }, item, exportData, finalPath, rewrites, added, true);
          }
        } else if (localExports.length > 1 && ctx.unsafeNamespace) {
          await buildUnsafeNamespaceRewrites(item, importedFile.exports, rewrites, ctx);
        }
      }

      if (item.type === "export" && item.name === "*") {
        const flattened = await buildStarReExportRewrites(item, importedFile.exports, rewrites, ctx);
        if (!flattened) ctx.tracker.addStarConsumer(importedFilePath, filePath);
      }

      // A target its consumer cannot name keeps the whole declaration and its barrel.
      const pos = `${item.pos.start}:${item.pos.end}`;
      const targets = [...(rewrites.get(pos) ?? [])];
      if (!unchanged.has(pos) && targets.some(([to, rewrite]) => !canSpellRewrite(filePath, to, rewrite, ctx))) {
        unchanged.add(pos);
        const names = item.names?.length ? item.names.map((n) => n.name) : [];
        if (names.length === 0) names.push(item.type === "default" ? "default" : (item.name ?? "*"));
        for (const name of names) {
          ctx.tracker.untraceableImports.push({ barrelPath: importedFilePath, consumerPath: filePath, name });
        }
      }
    }
  }

  for (const pos of unchanged) rewrites.delete(pos);

  return rewrites;
}

async function buildUnsafeNamespaceRewrites(
  item: ImportData,
  exports: ExportMap,
  rewrites: Rewrites,
  ctx: Context,
): Promise<void> {
  const pos = `${item.pos.start}:${item.pos.end}`;
  let posRewrites = rewrites.get(pos);
  if (!posRewrites) {
    posRewrites = new Map();
    rewrites.set(pos, posRewrites);
  }

  for (const [targetFilePath, exportData] of exports) {
    if (!isAbsolute(targetFilePath)) continue;
    if (isIgnoredPath(targetFilePath, ctx.base)) continue;

    const targetFile = await analyzeFile(targetFilePath, ctx);
    const exportedNames = [...exportData.exportedNames];
    if (exportedNames.length === 0 && !targetFile.isBarrel) {
      for (const [, targetExportData] of targetFile.exports) {
        exportedNames.push(...targetExportData.exportedNames);
      }
    }

    if (exportedNames.length === 0) continue;

    const existing = posRewrites.get(targetFilePath);
    if (!existing) {
      posRewrites.set(targetFilePath, {
        type: "import",
        named: exportedNames.map((name) => ({ name })),
        members: [],
        unsafeNsName: item.name,
        originalSpecifier: item.originalSpecifier,
        ...packageSpecifiers(item, exportData),
        specifierPrefix: item.specifierPrefix,
        specifierSuffix: item.specifierSuffix,
      });
    } else {
      for (const name of exportedNames) {
        if (!existing.named.some((n) => n.name === name)) {
          existing.named.push({ name });
        }
      }
      existing.unsafeNsName = item.name;
    }

    if (targetFile.isBarrel && ctx.only.length === 0) {
      ctx.tracker.register(targetFilePath);
    }
  }
}

async function buildStarReExportRewrites(
  item: ImportData,
  exports: ExportMap,
  rewrites: Rewrites,
  ctx: Context,
): Promise<boolean> {
  if (!(await canFlattenStarExports(exports, ctx, new Set()))) return false;

  const pos = `${item.pos.start}:${item.pos.end}`;
  let posRewrites = rewrites.get(pos);
  if (!posRewrites) {
    posRewrites = new Map();
    rewrites.set(pos, posRewrites);
  }

  const visited = new Map<string, boolean>();
  await traceStarExports(exports, posRewrites, item, ctx, visited, Boolean(item.isTypeOnly));
  return true;
}

async function canFlattenStarExports(exports: ExportMap, ctx: Context, visited: Set<string>): Promise<boolean> {
  for (const [targetFilePath, exportData] of exports) {
    if (!isAbsolute(targetFilePath) || isIgnoredPath(targetFilePath, ctx.base)) return false;
    if (
      !exportData.exportStar ||
      exportData.namedExports ||
      exportData.aliases ||
      exportData.exportedAsDefault ||
      exportData.reExportedNs
    ) {
      return false;
    }
    if (visited.has(targetFilePath)) continue;
    visited.add(targetFilePath);

    const targetFile = await analyzeFile(targetFilePath, ctx);
    if (targetFile.isBarrel && !(await canFlattenStarExports(targetFile.exports, ctx, visited))) return false;
  }

  return true;
}

async function traceStarExports(
  exports: ExportMap,
  posRewrites: Map<string, Rewrite>,
  item: ImportData,
  ctx: Context,
  visited: Map<string, boolean>,
  inheritedTypeOnly: boolean,
): Promise<void> {
  for (const [targetFilePath, exportData] of exports) {
    if (!isAbsolute(targetFilePath)) continue;
    if (isIgnoredPath(targetFilePath, ctx.base)) continue;
    const isTypeOnly = inheritedTypeOnly || Boolean(exportData.exportStarIsTypeOnly);
    const visitedAsTypeOnly = visited.get(targetFilePath);
    if (visitedAsTypeOnly === false || visitedAsTypeOnly === isTypeOnly) continue;
    visited.set(targetFilePath, isTypeOnly);

    const targetFile = await analyzeFile(targetFilePath, ctx);

    if (targetFile.isBarrel) {
      if (ctx.only.length === 0) {
        ctx.tracker.register(targetFilePath);
      }
      await traceStarExports(targetFile.exports, posRewrites, item, ctx, visited, isTypeOnly);
    } else {
      const existing = posRewrites.get(targetFilePath);
      if (!existing) {
        posRewrites.set(targetFilePath, {
          type: "export",
          named: [],
          members: [],
          isTypeOnly,
          originalSpecifier: item.originalSpecifier,
          ...packageSpecifiers(item, exportData),
          specifierPrefix: item.specifierPrefix,
          specifierSuffix: item.specifierSuffix,
        });
      } else if (!isTypeOnly) {
        existing.isTypeOnly = false;
      }
    }
  }
}
