// Runs one repository fingerprint on its own thread, so a large checkout never
// blocks the thread that serves the project socket. It is the same function the
// rest of the factory calls directly; only where it runs differs.
import { parentPort, workerData } from 'node:worker_threads';
import { repositoryIdentity } from './repository.mjs';

try { parentPort.postMessage({ identity: repositoryIdentity(workerData.root) }); }
catch (error) { parentPort.postMessage({ error: { message: error.message, code: error.code, path: error.path } }); }
