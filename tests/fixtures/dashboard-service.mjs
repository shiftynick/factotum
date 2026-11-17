import { startProjectService } from '../../starter/factory/service/project-service.mjs';
const service=await startProjectService({stateDir:process.argv[2],socketPath:process.argv[3],run:false});
process.send({type:'ready'});
process.on('SIGTERM',async()=>{await service.close();process.exit(0);});
