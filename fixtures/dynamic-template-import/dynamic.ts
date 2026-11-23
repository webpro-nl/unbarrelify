const loaded = await import(`./barrel.ts`);

export const value = loaded.n;
