import {h,time,relative} from './dom.mjs';
import {available} from './state.mjs';
import {commandButton} from './actions.mjs';
export function presenceControl(project){
 if(!project)return h('span',{class:'muted small',text:'Select a project to set availability'});
 const p=project.snapshot?.operatorPresence;
 if(!available(project)||!p)return h('span',{class:'muted small',text:'Availability unknown'});
 const here=p.state==='here',next=here?'away':'here';
 return h('div',{class:'presence-control',role:'group','aria-label':`Operator availability for ${project.name}`},
  h('div',{},h('strong',{class:'small',text:here?'Available':'Away'}),h('span',{class:'muted small',title:p.expiresAt?time(p.expiresAt):undefined,text:p.expiresAt?(p.expired?' · expired':` · expires ${relative(p.expiresAt)} (3h limit)`):' · 3h when set'})),
  commandButton(project,{key:`presence:${next}`,label:here?'I’m away':'I’m available',operation:'operator.presence',payload:{state:next,ttlMs:10800000,expectedVersion:p.version??0},reasons:project.snapshot.editPreconditions?.operatorPresenceVersion?[]:['Upgrade this project service for version-bound availability changes.'],subject:{label:'operator availability',version:p.version??0},showReasons:false}));
}
