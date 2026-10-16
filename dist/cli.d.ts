#!/usr/bin/env node
/**
 * `graft` CLI. Commands: build, ask, check, viz, mcp, callers, skeleton, grep,
 * map, init. Git is the sync: commit graft/ and a clone has the graph. A
 * workspace parent (≥2 git children) federates query commands across children.
 */
import "dotenv/config";
import type { Command } from "commander";
export declare function createCli(): Command;
export declare function runCli(argv?: string[]): Promise<number | string>;
