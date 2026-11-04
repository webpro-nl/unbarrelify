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
    const deleted: string[] = [];
    const preserved: PreservedBarrel[] = [];
    const toDelete = new Set<string>();

    let changed = true;
    while (changed) {
      changed = false;
      for (const [barrelPath, state] of this.barrels) {
        if (toDelete.has(barrelPath)) continue;
        if (!barrelPath.startsWith(ctx.base)) continue;
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
      if (!barrelPath.startsWith(ctx.base)) continue;
      if (isIgnoredPath(barrelPath, ctx.base)) continue;

      if (toDelete.has(barrelPath)) {
        deleted.push(barrelPath);
      } else {
        const reasons = this.getPreservationReasons(barrelPath, state, ctx, toDelete);
        for (const { reason, consumers } of reasons) {
          preserved.push({ path: barrelPath, reason, consumers });
        }
      }
    }

    return { deleted, preserved };
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

    for (const consumer of state.consumers) {
      if (state.rewrittenConsumers.has(consumer) || toDelete.has(consumer)) continue;
      if (state.starConsumers.has(consumer)) {
        starConsumers.push(consumer);
        continue;
      }
      if (JS_EXT_PATTERN.test(consumer)) nsConsumers.push(consumer);
      else nonTsConsumers.push(consumer);
    }

    const results: Array<Omit<PreservedBarrel, "path">> = [];
    if (nonTsConsumers.length > 0) results.push({ reason: "non-ts-import", consumers: nonTsConsumers });
    if (nsConsumers.length > 0) results.push({ reason: "namespace-import", consumers: nsConsumers });
    if (starConsumers.length > 0) results.push({ reason: "star-reexport", consumers: starConsumers });
    return results;
  }
}
