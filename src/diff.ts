import { styleText } from "node:util";
import ts from "typescript";
import {
  createImportDeclaration,
  createNsImportDeclaration,
  createReExportDeclaration,
  createUnsafeNamespaceDeclaration,
} from "./factory.ts";
import { printNode } from "./printer.ts";
import { buildRewriteSpecifier } from "./resolver.ts";
import type { RewriteContext } from "./rewriter.ts";
import type { Rewrite } from "./types.ts";

export interface ExampleCandidate {
  original: string;
  targetMap: Map<string, Rewrite>;
  filePath: string;
  singleQuote: boolean;
}

export function extractImportLine(text: string): string {
  const match = text.match(/^\s*(\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*(import|export)/);
  if (match) {
    const keywordIndex = text.indexOf(match[2], match[1]?.length ?? 0);
    return text.slice(keywordIndex).trim();
  }
  return text.trim();
}

export function formatExampleDiff(
  original: string,
  targetMap: Map<string, Rewrite>,
  filePath: string,
  ctx: RewriteContext,
): string {
  const dummySource = ts.createSourceFile("dummy.ts", "", ts.ScriptTarget.Latest);
  const replacements: string[] = [];
  let unsafeNsName: string | undefined;
  const unsafeNsIdentifiers: string[] = [];

  for (const [targetFilePath, rewrite] of targetMap) {
    const specifier = buildRewriteSpecifier(filePath, targetFilePath, rewrite, ctx);

    if (rewrite.unsafeNsName) {
      unsafeNsName = rewrite.unsafeNsName;
      for (const name of rewrite.named) {
        unsafeNsIdentifiers.push(name.alias ?? name.name);
      }
    }

    if (rewrite.reExportedNs) {
      replacements.push(
        printNode(createNsImportDeclaration(specifier, rewrite.reExportedNs, ctx.singleQuote), dummySource),
      );
    } else if (rewrite.type === "import") {
      replacements.push(printNode(createImportDeclaration(rewrite, specifier, ctx.singleQuote), dummySource));
    } else {
      replacements.push(printNode(createReExportDeclaration(rewrite, specifier, ctx.singleQuote), dummySource));
    }
  }

  if (unsafeNsName && unsafeNsIdentifiers.length > 0) {
    replacements.push(printNode(createUnsafeNamespaceDeclaration(unsafeNsName, unsafeNsIdentifiers), dummySource));
  }

  const lines = [styleText("red", `- ${original}`)];
  for (const line of replacements) {
    lines.push(styleText("green", `+ ${line}`));
  }
  return lines.join("\n");
}
