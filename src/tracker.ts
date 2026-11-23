import type { Context, PreservedBarrel, UntraceableImport } from "./types.ts";
import { isIgnoredPath, JS_EXT_PATTERN } from "./constants.ts";

interface BarrelState {
  consumers: Set<string>;
  rewrittenConsumers: Set<string>;
  dynamicConsumers: Set<string>;
  starConsumers: Set<string>;
}

export class BarrelTracker {
  readonly barrels = new Map<string, BarrelState>();
  readonly untraceableImports: UntraceableImport[] = [];
  readonly failedFiles = new Set<string>();

  register(barrelPath: string): boolean {
    if (this.barrels.has(barrelPath)) return false;
    this.barrels.set(barrelPath, {
      consumers: new Set(),
      rewrittenConsumers: new Set(),
      dynamicConsumers: new Set(),
      starConsumers: new Set(),
    });
    return true;
  }

  has(barrelPath: string): boolean {
    return this.barrels.has(barrelPath);
  }

  addConsumer(barrelPath: string, consumerPath: string): void {
    const state = this.barrels.get(barrelPath);
    if (state) state.consumers.add(consumerPath);
  }

  markRewritten(barrelPath: string, consumerPath: string): void {
    const state = this.barrels.get(barrelPath);
    if (state) state.rewrittenConsumers.add(consumerPath);
  }

  addDynamicConsumer(barrelPath: string, consumerPath: string): void {
    const state = this.barrels.get(barrelPath);
    if (state) state.dynamicConsumers.add(consumerPath);
  }

  addStarConsumer(barrelPath: string, consumerPath: string): void {
    const state = this.barrels.get(barrelPath);
    if (state) state.starConsumers.add(consumerPath);
  }

  classify(ctx: Context): { deleted: string[]; preserved: PreservedBarrel[] } {
    const preserved: PreservedBarrel[] = [];
    const toDelete = new Set<string>();

    let changed = true;
    while (changed) {
      changed = false;
      for (const [barrelPath, state] of this.barrels) {
        if (toDelete.has(barrelPath)) continue;
        if (!barrelPath.startsWith(ctx.base + "/")) continue;
        if (isIgnoredPath(barrelPath, ctx.base)) continue;
        if (state.dynamicConsumers.size > 0) continue;
        if (ctx.preservedBarrels.has(barrelPath) || ctx.isPackageEntryPoint(barrelPath)) continue;

        const unrewritten = this.getUnrewritten(state, toDelete);
        if (unrewritten.length > 0) continue;

        toDelete.add(barrelPath);
        changed = true;
      }
    }

    for (const [barrelPath, state] of this.barrels) {
      if (!barrelPath.startsWith(ctx.base + "/")) continue;
      if (isIgnoredPath(barrelPath, ctx.base)) continue;
      if (toDelete.has(barrelPath)) continue;

      for (const { reason, consumers } of this.getPreservationReasons(barrelPath, state, ctx, toDelete)) {
        preserved.push({ path: barrelPath, reason, consumers });
      }
    }

    return { deleted: [...toDelete], preserved };
  }

  consumersIn(barrelPath: string, paths: Set<string>): string[] {
    const state = this.barrels.get(barrelPath);
    if (!state) return [];
    return [...state.consumers].filter((consumer) => paths.has(consumer) && !state.rewrittenConsumers.has(consumer));
  }

  private getUnrewritten(state: BarrelState, toDelete: Set<string>): string[] {
    const unrewritten: string[] = [];
    for (const consumer of state.consumers) {
      if (!state.rewrittenConsumers.has(consumer) && !toDelete.has(consumer)) {
        unrewritten.push(consumer);
      }
    }
    return unrewritten;
  }

  private getPreservationReasons(
    barrelPath: string,
    state: BarrelState,
    ctx: Context,
    toDelete: Set<string>,
  ): Array<Omit<PreservedBarrel, "path">> {
    if (state.dynamicConsumers.size > 0) {
      return [{ reason: "dynamic-import", consumers: [...state.dynamicConsumers] }];
    }
    if (ctx.preservedBarrels.has(barrelPath) || ctx.isPackageEntryPoint(barrelPath)) {
      return [{ reason: "skip", consumers: [] }];
    }

    const nonTsConsumers: string[] = [];
    const nsConsumers: string[] = [];
    const starConsumers: string[] = [];
    const untracedConsumers: string[] = [];
    const barrelConsumers: string[] = [];
    const failedConsumers: string[] = [];
    const sideEffectConsumers: string[] = [];
    const untraced = new Set(
      this.untraceableImports.filter((entry) => entry.barrelPath === barrelPath).map((entry) => entry.consumerPath),
    );

    for (const consumer of state.consumers) {
      if (state.rewrittenConsumers.has(consumer) || toDelete.has(consumer)) continue;
      if (this.failedFiles.has(consumer)) {
        failedConsumers.push(consumer);
        continue;
      }
      if (state.starConsumers.has(consumer)) {
        starConsumers.push(consumer);
        continue;
      }
      if (untraced.has(consumer)) {
        untracedConsumers.push(consumer);
        continue;
      }
      const consumerImports = ctx.fileCache.get(consumer)?.imports.get(barrelPath);
      if (consumerImports && [...consumerImports].some((item) => item.type === "side-effect")) {
        sideEffectConsumers.push(consumer);
        continue;
      }
      if (this.barrels.has(consumer) || ctx.fileCache.get(consumer)?.isBarrel || ctx.includedBarrels.has(consumer)) {
        barrelConsumers.push(consumer);
        continue;
      }
      if (JS_EXT_PATTERN.test(consumer)) nsConsumers.push(consumer);
      else nonTsConsumers.push(consumer);
    }

    const results: Array<Omit<PreservedBarrel, "path">> = [];
    if (nonTsConsumers.length > 0) results.push({ reason: "non-ts-import", consumers: nonTsConsumers });
    if (nsConsumers.length > 0) results.push({ reason: "namespace-import", consumers: nsConsumers });
    if (starConsumers.length > 0) results.push({ reason: "star-reexport", consumers: starConsumers });
    if (untracedConsumers.length > 0) results.push({ reason: "untraceable-import", consumers: untracedConsumers });
    if (barrelConsumers.length > 0) results.push({ reason: "barrel-reexport", consumers: barrelConsumers });
    if (failedConsumers.length > 0) results.push({ reason: "consumer-error", consumers: failedConsumers });
    if (sideEffectConsumers.length > 0) results.push({ reason: "side-effect-import", consumers: sideEffectConsumers });
    return results;
  }
}
