#!/usr/bin/env node
import "dotenv/config";
import { tryResidentSearch } from "./search/client.js";
if (!await tryResidentSearch(process.argv.slice(2)))
    process.exitCode = await (await import("./cli.js")).runCli();
