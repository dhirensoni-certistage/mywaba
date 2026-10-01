/**
 * Must be the FIRST import of the custom server.
 *
 * Next.js keeps its request-scoped stores in `globalThis.AsyncLocalStorage`, which it normally
 * installs itself (node-environment-baseline) when `next` is required. Anything that pulls in
 * `next/headers` or `next/server` *before* that — in our case `next-auth`, imported by the
 * Socket.IO auth layer — captures a fake store and every later Next render crashes the process
 * with "Invariant: AsyncLocalStorage accessed in runtime where it is not available".
 * Installing the real AsyncLocalStorage up front, exactly like Next's own baseline does, makes
 * the import order irrelevant.
 */
import { AsyncLocalStorage } from "async_hooks";

const g = globalThis as typeof globalThis & { AsyncLocalStorage?: typeof AsyncLocalStorage };
if (typeof g.AsyncLocalStorage !== "function") {
  g.AsyncLocalStorage = AsyncLocalStorage;
}

export {};
