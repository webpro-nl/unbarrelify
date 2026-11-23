import type { TestContext } from "node:test";
import { join, resolve } from "node:path";
import { rm, cp, readFile, mkdtemp } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { glob } from "tinyglobby";

export const fixturesDir = resolve(import.meta.dirname, "../fixtures");

export function fixture(name: string): string {
  return join(fixturesDir, name);
}

export async function copyFixture(t: TestContext, name: string): Promise<string> {
  const dir = realpathSync(await mkdtemp(join(tmpdir(), `${name}-`)));
  await cp(join(fixturesDir, name), dir, { recursive: true });
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

export async function read(filePath: string): Promise<string> {
  return readFile(filePath, "utf-8");
}

export async function snapshotDir(dir: string): Promise<Map<string, string>> {
  const files = await glob("**/*", { cwd: dir, onlyFiles: true, dot: true });
  const snapshot = new Map<string, string>();
  for (const file of files.sort()) {
    snapshot.set(file, await readFile(join(dir, file), "utf-8"));
  }
  return snapshot;
}
