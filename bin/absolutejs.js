#!/usr/bin/env bun
import { main } from '../dist/cli.js';
process.exit(await main(process.argv.slice(2)));
