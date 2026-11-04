import type { SourceFile } from "typescript";
import type { BarrelTracker } from "./tracker.ts";

export interface Position {
  start: number;
  end: number;
}

export interface File {
  isBarrel: boolean;
  imports: ImportMap;
  exports: ExportMap;
  sourceFile: SourceFile;
  dynamicImports: Set<string>;
}

export interface ExportData {
  specifier: string;
  pos: Position;
  exportedNames: Set<string>;
  exportStar?: boolean;
  exportStarIsTypeOnly?: boolean;
  hasNamedExports?: boolean;
  reExportedNs?: string;
  externalSpecifier?: string;
  aliases?: Map<string, string>;
  exportedAsDefault?: string;
}

export type ExportMap = Map<string, ExportData>;

export interface Name {
  name: string;
  alias?: string;
  isType?: boolean;
}

export interface ImportData {
  name?: string;
  names?: Name[];
  members?: Name[];
  pos: Position;
  type: "named" | "default" | "ns" | "as" | "export";
  originalSpecifier?: string;
  isTypeOnly?: boolean;
  specifierPrefix?: string;
  specifierSuffix?: string;
}

export type ImportMap = Map<string, Set<ImportData>>;

export interface Rewrite {
  type: "import" | "export";
  ns?: string;
  named: Name[];
  members: Name[];
  externalSpecifier?: string;
  reExportedNs?: string;
  defaultName?: string;
  isTypeOnly?: boolean;
  originalSpecifier?: string;
  specifierPrefix?: string;
  specifierSuffix?: string;
  unsafeNsName?: string; // For --unsafe-namespace: the namespace identifier name
}

export type Rewrites = Map<string, Map<string, Rewrite>>;

export type RewritesByPosition = Array<[[number, number], Map<string, Rewrite>]>;

export interface PathAliases {
  baseUrl: string;
  configFile?: string;
  paths: Record<string, string[]>;
}

export type ProgressEvent =
  | { type: "files"; count: number }
  | { type: "barrel"; path: string }
  | { type: "scanning"; current: number; total: number }
  | { type: "rewriting" }
  | { type: "done" };

export interface Options {
  cwd: string;
  only?: string[];
  files?: string[];
  skip?: string[];
  barrel?: string[];
  ext?: string;
  write: boolean;
  check?: boolean;
  unsafeNamespace?: boolean;
  organizeImports?: boolean;
  progress?: (event: ProgressEvent) => void;
}

export interface Context {
  base: string;
  only: string[];
  ext: string | undefined;
  write: boolean;
  check: boolean;
  unsafeNamespace: boolean;
  organizeImports: boolean;
  progress: (event: ProgressEvent) => void;
  aliases: PathAliases | null;
  projectFiles: string[];
  preservedBarrels: Set<string>;
  includedBarrels: Set<string>;
  fileCache: Map<string, File>;
  sourceFileCache?: Map<string, SourceFile>;
  isPackageEntryPoint: (filePath: string) => boolean;
  tracker: BarrelTracker;
}

export interface PreservedBarrel {
  path: string;
  reason: "skip" | "namespace-import" | "non-ts-import" | "dynamic-import" | "star-reexport";
  consumers: string[];
}

export interface UntraceableImport {
  barrelPath: string;
  consumerPath: string;
  name: string;
}

export interface Result {
  modified: string[];
  deleted: string[];
  preserved: PreservedBarrel[];
  untraceableImports: UntraceableImport[];
  exampleDiff?: string;
}
