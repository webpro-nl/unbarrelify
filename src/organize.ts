import ts from "typescript";
import { printNode } from "./printer.ts";

export function organizeImports(content: string, filePath: string): string {
  const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest);
  const groups: ts.ImportDeclaration[][] = [];
  const adjacentGroups = new Map<string, ts.ImportDeclaration[]>();

  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) {
      adjacentGroups.clear();
      continue;
    }
    const specifier = stmt.moduleSpecifier.text;
    const group = adjacentGroups.get(specifier);
    if (group) group.push(stmt);
    else {
      const imports = [stmt];
      adjacentGroups.set(specifier, imports);
      groups.push(imports);
    }
  }

  let needsOrganize = false;
  for (const group of groups) {
    if (group.length > 1) {
      needsOrganize = true;
      break;
    }
  }
  if (!needsOrganize) return content;

  const edits: { start: number; end: number; text: string }[] = [];
  for (const group of groups) {
    if (group.length < 2) continue;
    if (
      group.some((imp) =>
        /@ts-(?:expect-error|ignore)\b/.test(content.slice(imp.getFullStart(), imp.getStart(sourceFile))),
      )
    ) {
      continue;
    }
    const organized: string[] = [];
    // @ts-expect-error testCoalesceImports internal fn
    for (const imp of ts.OrganizeImports.testCoalesceImports(group, false, sourceFile, {})) {
      // Leading and trailing comments remain outside the replacement ranges.
      ts.setEmitFlags(imp, ts.EmitFlags.NoLeadingComments | ts.EmitFlags.NoTrailingComments);
      organized.push(printNode(imp, sourceFile));
    }
    for (const [index, imp] of group.entries()) {
      edits.push({ start: imp.getStart(sourceFile), end: imp.end, text: index === 0 ? organized.join("\n") : "" });
    }
  }

  // Only replace imports, leaving interleaved statements and trivia intact.
  for (const { start, end, text } of edits.sort((a, b) => b.start - a.start)) {
    content = content.slice(0, start) + text + content.slice(end);
  }

  return content;
}
