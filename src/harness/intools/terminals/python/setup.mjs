import * as backend from '@anthropic-ai/sandbox-runtime';
import { acquirePythonLease } from './lease.mjs';
import { createPythonSetup } from './setup-core.mjs';

export const setupPythonSandbox = createPythonSetup({ backend, lease: acquirePythonLease, platform: process.platform });
