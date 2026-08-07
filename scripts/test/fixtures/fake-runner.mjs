/**
 * A stand-in for a real agent runner. It records the prompt it was handed and
 * the model it was asked for, then succeeds or fails on the model's say-so, so
 * the escalation ladder can be exercised without a network call.
 *
 * Usage: node fake-runner.mjs --model <model> --log <path>
 * A model containing "succeeds" exits 0; anything else exits 3.
 */
import { appendFileSync, readFileSync } from "node:fs";

const args = process.argv.slice(2);
const model = args[args.indexOf("--model") + 1] ?? "";
const log = args[args.indexOf("--log") + 1] ?? "";
const prompt = readFileSync(0, "utf8");

if (log) appendFileSync(log, `=== ${model} ===\n${prompt}\n`, "utf8");

if (model.includes("succeeds")) {
	process.stdout.write(`dropped by ${model}\n`);
	process.exit(0);
}

process.stdout.write(`${model} tried\n`);
process.stderr.write(`${model} gave up\n`);
process.exit(3);
