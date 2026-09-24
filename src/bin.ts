#!/usr/bin/env node
import { run } from "./cli/cli.js";
import { writeStartupError } from "./core/logger.js";

/** Converts CLI completion or startup failure into the process exit status. */
async function main(args: string[]): Promise<number> {
  try {
    return await run(args);
  } catch (error) {
    writeStartupError(error);
    return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
