#!/usr/bin/env node
import { main } from '../src/index.js';
// `bevara … | head` must not crash when the reader closes the pipe early.
for (const stream of [process.stdout, process.stderr]) stream.on('error', (e) => { if (e.code === 'EPIPE') process.exit(0); throw e; });
main(process.argv.slice(2));
