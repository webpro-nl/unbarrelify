import ts from "typescript";
import { printNode } from "./printer.ts";

export function organizeImports(content: string, filePath: string): string {
  const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest);
  const groups: ts.ImportDeclaration[][] = [];
  let previous: string | undefined;

  // Only consecutive imports merge: moving one past another module's import can change evaluation order.
  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) {
      previous = undefined;
      continue;
    }
    const specifier = stmt.moduleSpecifier.text;
    if (specifier === previous) groups[groups.length - 1].push(stmt);
    else groups.push([stmt]);
    previous = specifier;
  }

  let needsOrganize = false;
  for (const group of groups) {
    if (group.length > 1) {
      needsOrganize = true;
      break;
    }
  }
  if (!needsOrganize) return content;

  const hasOwnComments = (imp: ts.ImportDeclaration) =>
    ts.getLeadingCommentRanges(content, imp.getFullStart()) || ts.getTrailingCommentRanges(content, imp.end);
  const hasComments = (imp: ts.ImportDeclaration) =>
    hasOwnComments(imp) || containsComment(content.slice(imp.getStart(sourceFile), imp.end));

  const edits: { start: number; end: number; text: string }[] = [];
  for (const group of groups) {
    if (group.length < 2) continue;
    if (group.slice(1).some(hasComments)) continue;
    // @ts-expect-error testCoalesceImports internal fn
    const coalesced: ts.ImportDeclaration[] = ts.OrganizeImports.testCoalesceImports(group, false, sourceFile, {});
    // The first import's comments would precede the first emitted declaration, which may not be that import.
    if (coalesced.length > 1 && hasOwnComments(group[0])) continue;
    const organized = coalesced.map((imp) => {
      // Leading and trailing comments remain outside the replacement ranges.
      ts.setEmitFlags(imp, ts.EmitFlags.NoLeadingComments | ts.EmitFlags.NoTrailingComments);
      return printNode(imp, sourceFile);
    });
    for (const [index, imp] of group.entries()) {
      const start = imp.getStart(sourceFile);
      const lineStart = content.lastIndexOf("\n", start - 1) + 1;
      const lineBreak = content.indexOf("\n", imp.end);
      const lineEnd = lineBreak === -1 ? content.length : lineBreak + 1;
      const ownLine = !content.slice(lineStart, start).trim() && !content.slice(imp.end, lineEnd).trim();
      if (index > 0 && ownLine) {
        edits.push({ start: lineStart, end: lineEnd, text: "" });
      } else {
        const eol = /\r\n/.test(content) ? "\r\n" : "\n";
        edits.push({ start, end: imp.end, text: index === 0 ? organized.join(eol) : "" });
      }
    }
  }

  // Only replace imports, leaving interleaved statements and trivia intact.
  for (const { start, end, text } of edits.sort((a, b) => b.start - a.start)) {
    content = content.slice(0, start) + text + content.slice(end);
  }

  return content;
}

function containsComment(text: string): boolean {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, text);
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (token === ts.SyntaxKind.SingleLineCommentTrivia || token === ts.SyntaxKind.MultiLineCommentTrivia) return true;
  }
  return false;
}
