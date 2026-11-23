export const EXTENSIONS = ["ts", "tsx", "js", "jsx", "mjs", "mts", "cjs", "cts"] as const;
const JS_EXTENSIONS = EXTENSIONS.map((id) => `.${id}`);
export const JS_EXT_PATTERN = new RegExp(`\\.(${EXTENSIONS.join("|")})$`);
export const DEFAULT_GLOBS = JS_EXTENSIONS.map((ext) => `**/*${ext}`);
export const RESOLVER_EXTENSIONS = [...JS_EXTENSIONS, ".json"] as const;
export const TS_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);
export const MODULE_FORMAT_EXTENSIONS = new Map([
  [".mts", ".mjs"],
  [".mjs", ".mjs"],
  [".cts", ".cjs"],
  [".cjs", ".cjs"],
]);

const IGNORED_PATH_PATTERN = /\/node_modules\/|\.d\.ts$/;
// TODO: properly respect .ignore
const BUILD_OUTPUT_DIRS = /^(?:apps|packages|libs|modules)\/[^/]+\/(dist|build|out|coverage)\//;

export function isIgnoredPath(filePath: string, base?: string): boolean {
  if (IGNORED_PATH_PATTERN.test(filePath)) return true;
  if (base) {
    const relativePath = filePath.startsWith(base + "/") ? filePath.slice(base.length + 1) : filePath;
    if (BUILD_OUTPUT_DIRS.test(relativePath)) return true;
  }
  return false;
}
