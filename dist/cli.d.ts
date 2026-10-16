#!/usr/bin/env node
/**
 * `grafly` CLI. Commands include build, ask, check, viz, callers, skeleton, grep,
 * map, init. The local graph lives in the regenerable `.grafly/` directory. A
 * workspace parent (≥2 git children) federates query commands across children.
 */
import "dotenv/config";
import type { Command } from "commander";
export declare function createCli(): Command;
export declare function runCli(argv?: string[]): Promise<number | string>;
