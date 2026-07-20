#!/usr/bin/env node
import { runCli } from "./nosedive.js";

runCli().catch((err: unknown) => {
  if (err instanceof Error) console.error(`nosedive: ${err.message}`);
  else console.error(`nosedive: ${String(err)}`);
  process.exit(1);
});
