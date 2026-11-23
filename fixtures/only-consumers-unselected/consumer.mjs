const loaded = await import("./barrel.mjs");
import { other } from "./unselected.mjs";
console.log(loaded.value, other);
