#!/usr/bin/env node
"use client";
// Keep the public value.
import { foo } from "./barrel.ts";
export const saved = foo;
console.log("before", saved);
import "./effect.ts";
// Keep the calculation between imports.
function sum(a: number, b: number) {
  return a + b;
}
import { bar } from "./value.ts";
console.log("after", saved, bar);
export const total = sum(saved, bar);
