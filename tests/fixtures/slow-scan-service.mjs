// Separate process: test-client deadlines must not share the server's blocked loop.
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { startProjectService } from '../../starter/factory/service/project-service.mjs';
import { waitingOnMain } from '../../starter/factory/operations/main-freshness.mjs';
const real = childProcess.execFileSync, wait = new Int32Array(new SharedArrayBuffer(4));
let scans = 0;
childProcess.execFileSync = (binary,args,options) => {
  if (binary === 'git' && args[0] === '--no-optional-locks') { scans++; Atomics.wait(wait,0,0,50); }
  return real(binary,args,options);
};
syncBuiltinESMExports();
const app = await startProjectService({stateDir:process.argv[2],socketPath:process.argv[3],run:false});
process.on('message', message => {
  if (message === 'scan') {
    scans = 0; process.send({type:'scanning'});
    const waiting = waitingOnMain(app.store).length;
    process.send({type:'scanned',scans,waiting});
  } else if (message === 'count') process.send({type:'count',scans});
});
process.on('disconnect',async()=>{await app.close();process.exit(0);});
process.send({type:'ready'});
