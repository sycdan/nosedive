#!/usr/bin/env node
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { version } = require("../package.json");

const USAGE = `Usage: nosedive <command>

Commands:
  version  Print the package version
`;

const [command] = process.argv.slice(2);

switch (command) {
  case "version":
  case "--version":
  case "-v":
    console.log(version);
    break;
  case undefined:
  case "help":
  case "--help":
  case "-h":
    console.log(USAGE);
    break;
  default:
    console.error(`Unknown command: ${command}\n\n${USAGE}`);
    process.exit(1);
}
