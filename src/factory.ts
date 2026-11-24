import ts from "typescript";
import type { Rewrite } from "./types.ts";

export function createImportDeclaration(
  rewrite: Rewrite,
  specifier: string,
  singleQuote = false,
): ts.ImportDeclaration {
  const defaultName = rewrite.defaultName ? ts.factory.createIdentifier(rewrite.defaultName) : undefined;
  const namedIds = [...(rewrite.named ?? []), ...(rewrite.members ?? [])];
  const isTypeOnly = !rewrite.defaultName && namedIds.every((item) => item.isType);

  const identifiers =
    namedIds.length > 0
      ? namedIds.map((name) =>
          ts.factory.createImportSpecifier(
            !isTypeOnly && Boolean(name.isType),
            name.alias ? ts.factory.createIdentifier(name.name) : undefined,
            ts.factory.createIdentifier(name.alias ?? name.name),
          ),
        )
      : undefined;

  const namedImports = identifiers?.length ? ts.factory.createNamedImports(identifiers) : undefined;
  const importClause = ts.factory.createImportClause(isTypeOnly, defaultName, namedImports);

  return ts.factory.createImportDeclaration(
    undefined,
    importClause,
    ts.factory.createStringLiteral(specifier, singleQuote),
  );
}

export function createNsImportDeclaration(
  specifier: string,
  namespace: string,
  singleQuote = false,
  isTypeOnly = false,
): ts.ImportDeclaration {
  return ts.factory.createImportDeclaration(
    undefined,
    ts.factory.createImportClause(
      isTypeOnly,
      undefined,
      ts.factory.createNamespaceImport(ts.factory.createIdentifier(namespace)),
    ),
    ts.factory.createStringLiteral(specifier, singleQuote),
    undefined,
  );
}

export function createReExportDeclaration(
  rewrite: Rewrite,
  specifier: string,
  singleQuote = false,
): ts.ExportDeclaration {
  const namedIds = rewrite.named ?? [];
  const isTypeOnly =
    rewrite.isTypeOnly ?? (!rewrite.defaultName && namedIds.length > 0 && namedIds.every((item) => item.isType));

  const identifiers =
    namedIds.length > 0
      ? namedIds.map((name) =>
          ts.factory.createExportSpecifier(
            !isTypeOnly && Boolean(name.isType),
            name.alias ? ts.factory.createIdentifier(name.name) : undefined,
            ts.factory.createIdentifier(name.alias ?? name.name),
          ),
        )
      : undefined;

  const namedExports = identifiers?.length ? ts.factory.createNamedExports(identifiers) : undefined;

  return ts.factory.createExportDeclaration(
    undefined,
    isTypeOnly,
    namedExports,
    ts.factory.createStringLiteral(specifier, singleQuote),
    undefined,
  );
}

export function createUnsafeNamespaceDeclaration(nsName: string, identifiers: string[]): ts.VariableStatement {
  const properties = identifiers.map((id) =>
    ts.factory.createShorthandPropertyAssignment(ts.factory.createIdentifier(id)),
  );

  const objectLiteral = ts.factory.createObjectLiteralExpression(properties, false);

  const declaration = ts.factory.createVariableDeclaration(
    ts.factory.createIdentifier(nsName),
    undefined,
    undefined,
    objectLiteral,
  );

  return ts.factory.createVariableStatement(
    undefined,
    ts.factory.createVariableDeclarationList([declaration], ts.NodeFlags.Const),
  );
}
