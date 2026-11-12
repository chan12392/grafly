#!/usr/bin/env node
import { tryResidentSearch } from "./search/client.js";
// `--read-only` anywhere on the command line is the same switch as GRAFLY_READONLY=1, which every
// command and the resident service (it forwards GRAFLY_* env) already honour.
if (process.argv.slice(2).includes("--read-only"))
    process.env.GRAFLY_READONLY = "1";
if (!await tryResidentSearch(process.argv.slice(2)))
    process.exitCode = await (await import("./cli.js")).runCli();
