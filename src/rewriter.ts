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
import { buildSpecifier } from "./resolver.ts";
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

export function buildRewriteItem(name: Name, importItem: ImportData, exportItem: ExportData): Rewrite {
  const isDefault = name.name === "default";
  const isReExport = importItem.type === "export";
  return {
    type: isReExport ? "export" : "import",
    ns: isDefault ? undefined : importItem.name,
    named:
      isDefault && isReExport ? [{ name: "default", alias: name.alias ?? importItem.name }] : isDefault ? [] : [name],
    members: importItem.type === "ns" && !isDefault ? [{ name: name.name }] : [],
    externalSpecifier: exportItem.externalSpecifier,
    reExportedNs: exportItem.reExportedNs,
    defaultName: isDefault && !isReExport ? (name.alias ?? importItem.name) : undefined,
    originalSpecifier: importItem.originalSpecifier,
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
      const baseSpecifier =
        rewrite.externalSpecifier ??
        buildSpecifier(filePath, targetFilePath, {
          ext: ctx.ext,
          originalSpecifier: rewrite.originalSpecifier,
          aliases: ctx.aliases,
        });
      const specifier = (rewrite.specifierPrefix ?? "") + baseSpecifier + (rewrite.specifierSuffix ?? "");

      if (rewrite.unsafeNsName) {
        unsafeNsName = rewrite.unsafeNsName;
        for (const name of rewrite.named) {
          unsafeNsIdentifiers.push(name.alias ?? name.name);
        }
      }

      if (rewrite.reExportedNs) {
        replacements.push(
          printNode(createNsImportDeclaration(specifier, rewrite.reExportedNs, singleQuote), sourceFile),
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
  if (exportItem.exportedNames.size === 0) {
    return !!exportItem.externalSpecifier;
  }
  if (exportItem.exportedNames.has(name.name)) return true;
  if (exportItem.aliases?.has(name.name)) return true;
  if (exportItem.reExportedNs === name.name) return true;
  return false;
}

function addRewrite(
  name: Name,
  importItem: ImportData,
  exportItem: ExportData,
  targetFilePath: string,
  rewrites: Rewrites,
  added: Set<string>,
): boolean {
  const pos = `${importItem.pos.start}:${importItem.pos.end}`;
  const nameKey = `${pos}:${name.name}:${name.alias ?? ""}`;
  if (added.has(nameKey)) return false;
  added.add(nameKey);

  let posRewrites = rewrites.get(pos);
  if (!posRewrites) {
    posRewrites = new Map();
    rewrites.set(pos, posRewrites);
  }

  const existing = posRewrites.get(targetFilePath);
  if (!existing) {
    posRewrites.set(targetFilePath, buildRewriteItem(name, importItem, exportItem));
  } else {
    if (importItem.type === "ns") {
      existing.members.push({ name: name.name });
    } else {
      existing.named.push(name);
    }
    if (exportItem.reExportedNs) {
      existing.reExportedNs = exportItem.reExportedNs;
    }
  }

  return true;
}

async function traceExport(
  name: Name,
  importItem: ImportData,
  exports: ExportMap | undefined,
  rewrites: Rewrites,
  ctx: Context,
  added: Set<string>,
  visiting: Set<string> = new Set(),
): Promise<boolean> {
  if (!exports) return false;

  for (const [targetFilePath, exportItem] of exports) {
    const isExported = isNameExported(name, exportItem);
    if (!isExported && !exportItem.exportStar) continue;

    if (!isAbsolute(targetFilePath)) {
      if (exportItem.exportedNames.size === 0 || exportItem.exportedNames.has(name.name)) {
        if (addRewrite(name, importItem, exportItem, targetFilePath, rewrites, added)) {
          return true;
        }
      }
      continue;
    }

    if (exportItem.externalSpecifier) {
      if (exportItem.exportedNames.size === 0 || exportItem.exportedNames.has(name.name)) {
        if (addRewrite(name, importItem, exportItem, exportItem.externalSpecifier, rewrites, added)) {
          return true;
        }
      }
      continue;
    }

    if (isIgnoredPath(targetFilePath, ctx.base)) continue;

    const alias = exportItem.aliases?.get(name.name);
    let effectiveName: Name;

    if (name.name === "default" && exportItem.exportedAsDefault) {
      const localName = name.alias ?? importItem.name;
      effectiveName = {
        name: exportItem.exportedAsDefault,
        alias: localName === exportItem.exportedAsDefault ? undefined : localName,
      };
    } else if (alias) {
      effectiveName = { name: alias, alias: name.alias ?? name.name };
    } else {
      effectiveName = name;
    }

    const targetFile = await analyzeFile(targetFilePath, ctx);

    if (!targetFile.isBarrel) {
      if (isExported && addRewrite(effectiveName, importItem, exportItem, targetFilePath, rewrites, added)) {
        return true;
      }
    } else if (ctx.only.length === 0) {
      ctx.tracker.register(targetFilePath);
    }

    const visitKey = `${targetFilePath}:${effectiveName.name}:${effectiveName.alias ?? ""}`;
    if (visiting.has(visitKey)) continue;
    visiting.add(visitKey);
    const found = await traceExport(effectiveName, importItem, targetFile.exports, rewrites, ctx, added, visiting);
    visiting.delete(visitKey);
    if (found) return true;
  }

  return false;
}

export async function buildRewrites(analysis: File, filePath: string, ctx: Context): Promise<Rewrites> {
  const rewrites: Rewrites = new Map();
  const added = new Set<string>();
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

      for (const name of item.names ?? []) {
        const found = await traceExport(name, item, importedFile.exports, rewrites, ctx, added);
        if (!found) {
          ctx.tracker.untraceableImports.push({
            barrelPath: importedFilePath,
            consumerPath: filePath,
            name: name.name,
          });
        }
      }

      for (const member of item.members ?? []) {
        await traceExport(member, item, importedFile.exports, rewrites, ctx, added);
      }

      if (item.type === "default") {
        const found = await traceExport({ name: "default" }, item, importedFile.exports, rewrites, ctx, added);
        if (!found) {
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
          if (finalPath && (exportData.exportedNames.size > 0 || exportData.externalSpecifier)) {
            addRewrite(
              { name: item.name },
              item,
              { ...exportData, reExportedNs: item.name },
              finalPath,
              rewrites,
              added,
            );
          }
        } else if (localExports.length > 1 && ctx.unsafeNamespace) {
          await buildUnsafeNamespaceRewrites(item, importedFile.exports, rewrites, ctx);
        }
      }

      if (item.type === "export" && item.name === "*") {
        const flattened = await buildStarReExportRewrites(item, importedFile.exports, rewrites, ctx);
        if (!flattened) ctx.tracker.addStarConsumer(importedFilePath, filePath);
      }
    }
  }

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
      exportData.hasNamedExports ||
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
          specifierPrefix: item.specifierPrefix,
          specifierSuffix: item.specifierSuffix,
        });
      } else if (!isTypeOnly) {
        existing.isTypeOnly = false;
      }
    }
  }
}
