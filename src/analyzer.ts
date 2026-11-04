import { isAbsolute } from "node:path";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { resolveModule } from "./resolver.ts";
import type { Context, ExportMap, File, ImportMap, PathAliases } from "./types.ts";

const CHAR_EXCLAMATION = 33; // '!'
const CHAR_QUESTION = 63; // '?'
const CHAR_HASH = 35; // '#'

interface ParsedSpecifier {
  prefix: string;
  path: string;
  suffix: string;
}

export function parseSpecifier(specifier: string): ParsedSpecifier {
  const len = specifier.length;
  let lastBang = -1;
  let suffixStart = len;

  for (let i = 0; i < len; i++) {
    const ch = specifier.charCodeAt(i);
    if (ch === CHAR_EXCLAMATION) {
      lastBang = i;
    } else if (ch === CHAR_QUESTION || ch === CHAR_HASH) {
      suffixStart = i;
      break;
    }
  }

  const pathStart = lastBang + 1;
  return {
    prefix: specifier.slice(0, pathStart),
    path: specifier.slice(pathStart, suffixStart),
    suffix: specifier.slice(suffixStart),
  };
}

export async function analyzeFile(filePath: string, ctx: Context): Promise<File> {
  const cached = ctx.fileCache.get(filePath);
  if (cached) return cached;

  const content = await readFile(filePath, "utf-8");
  const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest);

  const isBarrel = checkIsBarrel(sourceFile);
  const exports = await buildExportMap(sourceFile, ctx.aliases, (ctx.sourceFileCache ??= new Map()));
  const imports = buildImportMap(sourceFile, ctx.aliases);
  const dynamicImports = isBarrel ? new Set<string>() : findDynamicImports(sourceFile, ctx.aliases);

  const file: File = { isBarrel, exports, imports, sourceFile, dynamicImports };
  ctx.fileCache.set(filePath, file);
  return file;
}

export function checkIsBarrel(sourceFile: ts.SourceFile): boolean {
  return sourceFile.statements.length > 0 && sourceFile.statements.every(ts.isExportDeclaration);
}

function extractExportedNames(sourceFile: ts.SourceFile): Set<string> {
  const names = new Set<string>();

  for (const node of sourceFile.statements) {
    if (ts.canHaveModifiers(node)) {
      const modifiers = ts.getModifiers(node);
      if (modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
        if (modifiers.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) {
          names.add("default");
        } else {
          extractExportedName(node, names);
        }
      }
    }

    if (ts.isExportAssignment(node)) {
      names.add("default");
    }

    if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const element of node.exportClause.elements) {
        names.add(element.name.text);
      }
    }
  }

  return names;
}

export async function getExportedNames(
  filePath: string,
  sourceFileCache = new Map<string, ts.SourceFile>(),
): Promise<Set<string>> {
  let sourceFile = sourceFileCache.get(filePath);
  if (!sourceFile) {
    const content = await readFile(filePath, "utf-8");
    sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest);
    sourceFileCache.set(filePath, sourceFile);
  }
  return extractExportedNames(sourceFile);
}

function extractExportedName(node: ts.Node, names: Set<string>): void {
  if (ts.isVariableStatement(node)) {
    for (const decl of node.declarationList.declarations) {
      if (ts.isIdentifier(decl.name)) names.add(decl.name.text);
    }
  } else if (
    (ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isEnumDeclaration(node) ||
      ts.isModuleDeclaration(node)) &&
    node.name &&
    ts.isIdentifier(node.name)
  ) {
    names.add(node.name.text);
  }
}

export async function buildExportMap(
  sourceFile: ts.SourceFile,
  aliases: PathAliases | null,
  sourceFileCache = new Map<string, ts.SourceFile>(),
): Promise<ExportMap> {
  const exports: ExportMap = new Map();

  for (const node of sourceFile.statements) {
    if (!ts.isExportDeclaration(node) || !node.moduleSpecifier || !ts.isStringLiteral(node.moduleSpecifier)) {
      continue;
    }

    const specifier = node.moduleSpecifier.text;
    const resolvedPath = resolveModule(sourceFile.fileName, specifier, aliases);
    if (!resolvedPath) continue;

    const pos = { start: node.getStart(sourceFile), end: node.end };

    if (isAbsolute(resolvedPath)) {
      await processLocalExport(exports, node, resolvedPath, specifier, pos, sourceFileCache);
    } else {
      processExternalExport(exports, node, specifier, pos);
    }
  }

  return exports;
}

async function processLocalExport(
  exports: ExportMap,
  node: ts.ExportDeclaration,
  resolvedPath: string,
  specifier: string,
  pos: { start: number; end: number },
  sourceFileCache: Map<string, ts.SourceFile>,
): Promise<void> {
  if (node.exportClause && ts.isNamedExports(node.exportClause)) {
    const exportedNames = new Set<string>();
    const aliases = new Map<string, string>();
    let exportedAsDefault: string | undefined;

    for (const element of node.exportClause.elements) {
      exportedNames.add(element.name.text);
      if (element.propertyName && element.propertyName.text !== element.name.text) {
        aliases.set(element.name.text, element.propertyName.text);
      }
      if (element.name.text === "default" && element.propertyName) {
        exportedAsDefault = element.propertyName.text;
      }
    }

    mergeExport(exports, resolvedPath, {
      specifier,
      pos,
      exportedNames,
      hasNamedExports: true,
      aliases: aliases.size > 0 ? aliases : undefined,
      exportedAsDefault,
    });
  } else {
    const namespace =
      node.exportClause && ts.isNamespaceExport(node.exportClause) ? node.exportClause.name.text : undefined;
    const exportedNames = await getExportedNames(resolvedPath, sourceFileCache);

    mergeExport(exports, resolvedPath, {
      specifier,
      pos,
      exportedNames,
      exportStar: !node.exportClause,
      exportStarIsTypeOnly: !node.exportClause ? node.isTypeOnly : undefined,
      reExportedNs: namespace,
      externalSpecifier: specifier.startsWith(".") ? undefined : specifier,
    });
  }
}

function processExternalExport(
  exports: ExportMap,
  node: ts.ExportDeclaration,
  specifier: string,
  pos: { start: number; end: number },
): void {
  const namespace =
    node.exportClause && ts.isNamespaceExport(node.exportClause) ? node.exportClause.name.text : undefined;

  const exportedNames = new Set<string>();
  if (node.exportClause && ts.isNamedExports(node.exportClause)) {
    for (const element of node.exportClause.elements) {
      exportedNames.add(element.name.text);
    }
  }

  exports.set(specifier, {
    specifier,
    pos,
    exportedNames,
    exportStar: !node.exportClause,
    exportStarIsTypeOnly: !node.exportClause ? node.isTypeOnly : undefined,
    hasNamedExports: Boolean(node.exportClause && ts.isNamedExports(node.exportClause)),
    reExportedNs: namespace,
    externalSpecifier: specifier,
  });
}

function mergeExport(exports: ExportMap, path: string, data: ExportMap extends Map<string, infer T> ? T : never): void {
  const existing = exports.get(path);
  if (!existing) {
    exports.set(path, data);
    return;
  }

  for (const name of data.exportedNames) {
    existing.exportedNames.add(name);
  }

  if (data.aliases) {
    existing.aliases = existing.aliases || new Map();
    for (const [k, v] of data.aliases) {
      existing.aliases.set(k, v);
    }
  }

  if (data.exportStar) {
    existing.exportStarIsTypeOnly = existing.exportStar
      ? Boolean(existing.exportStarIsTypeOnly && data.exportStarIsTypeOnly)
      : data.exportStarIsTypeOnly;
    existing.exportStar = true;
  }

  if (data.hasNamedExports) {
    existing.hasNamedExports = true;
  }

  if (data.exportedAsDefault && !existing.exportedAsDefault) {
    existing.exportedAsDefault = data.exportedAsDefault;
  }

  if (data.reExportedNs && !existing.reExportedNs) {
    existing.reExportedNs = data.reExportedNs;
  }
}

export function buildImportMap(sourceFile: ts.SourceFile, aliases: PathAliases | null): ImportMap {
  const imports: ImportMap = new Map();

  for (const node of sourceFile.statements) {
    if (ts.isImportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      processImportDeclaration(imports, node, sourceFile, aliases);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      processReExportDeclaration(imports, node, sourceFile, aliases);
    }
  }

  return imports;
}

function processImportDeclaration(
  imports: ImportMap,
  node: ts.ImportDeclaration,
  sourceFile: ts.SourceFile,
  aliases: PathAliases | null,
): void {
  const originalSpecifier = (node.moduleSpecifier as ts.StringLiteral).text;
  const { prefix, path, suffix } = parseSpecifier(originalSpecifier);
  const resolvedPath = resolveModule(sourceFile.fileName, path, aliases);
  if (!resolvedPath || !isAbsolute(resolvedPath)) return;

  const clause = node.importClause;
  if (!clause) return;

  const pos = { start: node.getStart(sourceFile), end: node.end };
  const specifierPrefix = prefix || undefined;
  const specifierSuffix = suffix || undefined;

  if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
    addToImportMap(imports, resolvedPath, {
      name: clause.namedBindings.name.text,
      type: "ns",
      pos,
      members: [],
      originalSpecifier: path,
      specifierPrefix,
      specifierSuffix,
    });
  } else if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
    for (const element of clause.namedBindings.elements) {
      const isType = element.isTypeOnly || clause.isTypeOnly;
      const propertyName = element.propertyName;
      const hasAlias = propertyName && ts.isIdentifier(propertyName);

      addToImportMap(imports, resolvedPath, {
        names: [
          {
            name: hasAlias ? propertyName.text : element.name.text,
            alias: hasAlias ? element.name.text : undefined,
            isType,
          },
        ],
        type: hasAlias ? "as" : "named",
        pos,
        originalSpecifier: path,
        specifierPrefix,
        specifierSuffix,
      });
    }
  }

  if (clause.name && ts.isIdentifier(clause.name)) {
    addToImportMap(imports, resolvedPath, {
      name: clause.name.text,
      type: "default",
      pos,
      originalSpecifier: path,
      specifierPrefix,
      specifierSuffix,
    });
  }
}

function processReExportDeclaration(
  imports: ImportMap,
  node: ts.ExportDeclaration,
  sourceFile: ts.SourceFile,
  aliases: PathAliases | null,
): void {
  const originalSpecifier = (node.moduleSpecifier as ts.StringLiteral).text;
  const { prefix, path, suffix } = parseSpecifier(originalSpecifier);
  const resolvedPath = resolveModule(sourceFile.fileName, path, aliases);
  if (!resolvedPath || !isAbsolute(resolvedPath)) return;

  const pos = { start: node.getStart(sourceFile), end: node.end };
  const specifierPrefix = prefix || undefined;
  const specifierSuffix = suffix || undefined;

  if (node.exportClause && ts.isNamedExports(node.exportClause)) {
    for (const element of node.exportClause.elements) {
      const isType = element.isTypeOnly || node.isTypeOnly;
      const hasAlias = element.propertyName && ts.isIdentifier(element.propertyName);
      const propertyName = hasAlias ? element.propertyName : undefined;

      addToImportMap(imports, resolvedPath, {
        names: [
          {
            name: propertyName ? propertyName.text : element.name.text,
            alias: hasAlias ? element.name.text : undefined,
            isType,
          },
        ],
        type: "export",
        pos,
        originalSpecifier: path,
        specifierPrefix,
        specifierSuffix,
      });
    }
  } else {
    addToImportMap(imports, resolvedPath, {
      name: "*",
      type: "export",
      pos,
      isTypeOnly: node.isTypeOnly,
      originalSpecifier: path,
      specifierPrefix,
      specifierSuffix,
    });
  }
}

function addToImportMap(
  imports: ImportMap,
  filePath: string,
  item: ImportMap extends Map<string, Set<infer T>> ? T : never,
): void {
  const existing = imports.get(filePath);
  if (existing) {
    existing.add(item);
  } else {
    imports.set(filePath, new Set([item]));
  }
}

function findDynamicImports(sourceFile: ts.SourceFile, aliases: PathAliases | null): Set<string> {
  const dynamicImports = new Set<string>();

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = node.arguments[0];
      if (arg && ts.isStringLiteral(arg)) {
        const resolvedPath = resolveModule(sourceFile.fileName, arg.text, aliases);
        if (resolvedPath && isAbsolute(resolvedPath)) {
          dynamicImports.add(resolvedPath);
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return dynamicImports;
}
