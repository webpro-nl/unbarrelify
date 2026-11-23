import { foo } from "./barrel.ts";
console.log(foo)
import { bar } from "./value.ts";
(() => console.log(bar))();
