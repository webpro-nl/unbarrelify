import type { Token } from "./barrel.ts";
import type { default as Fallback } from "./barrel.ts";
const token: Token = "yes";
const fallback: Fallback = token;
console.log(fallback);
