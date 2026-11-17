import {assert,digest,id,now,uid} from './contracts.mjs';
import {authorityLedgerEnabled} from './decision-authority.mjs';
import {assertCurrentQuestion} from './stale-question.mjs';
import {inboxResolution,wakePresenterInTransaction} from '../operations/notifications.mjs';
export function operatorPresence(store,{nowMs=Date.now()}={}){
  const saved=store.meta('operatorPresence',null),here=saved?.state==='here'&&Date.parse(saved.expiresAt)>nowMs;
  return {version:saved?.version??0,state:here?'here':'away',declaredState:saved?.state??null,observedAt:saved?.observedAt??null,expiresAt:saved?.expiresAt??null,expired:Boolean(saved&&Date.parse(saved.expiresAt)<=nowMs)};
}
export function setOperatorPresence(store,p,actor,{delegated=false}={}){
  assert(actor==='operator'||delegated,'only the operator can declare presence');assert(['here','away'].includes(p.state),'presence state must be here or away');
  const previous=store.meta('operatorPresence',null);if(p.expectedVersion!==undefined)assert(p.expectedVersion===(previous?.version??0),'operator availability changed; refresh before setting it');
  const ttlMs=p.ttlMs??3*3600000;assert(Number.isSafeInteger(ttlMs)&&ttlMs>0&&ttlMs<=3*3600000,'presence lifetime must be positive and at most three hours');
  const observedAt=now(),row={version:(previous?.version??0)+1,state:p.state,observedAt,expiresAt:new Date(Date.parse(observedAt)+ttlMs).toISOString()};store.setMeta('operatorPresence',row);store.event('operator.presence',row);return operatorPresence(store);
}
const boundedText=(value,label,max)=>assert(typeof value==='string'&&value.trim()&&value.length<=max,`${label} required and bounded`);
// Publication v2 (migrated projects only): purpose "informational" is an ordinary
// question or notice that says so; purpose "decision" is routed to decision.present
// and bound to an exact decision version. A schema-1 project keeps the v1 field set.
export function publishStandaloneInbox(store,p,actor){
  const v2=authorityLedgerEnabled(store)&&p.purpose!==undefined;
  if(v2)assert(p.purpose==='informational','purpose is informational or decision; a decision card is published from its decision');
  const allowed=new Set(['id','kind','title','context','question','choices','expiryMs','links','remind',...(v2?['purpose']:[])]);assert(Object.keys(p).every(key=>allowed.has(key)),'unsupported standalone inbox field');
  assert(['notice','question'].includes(p.kind),'standalone inbox kind required');boundedText(p.title,'title',240);boundedText(p.context,'context',16000);
  const inboxId=p.id?id(p.id,'inbox id'):uid();assert(!store.get('inbox',inboxId),'inbox id already exists');
  const row={id:inboxId,standalone:true,kind:p.kind,status:'open',role:'operator',version:1,title:p.title,context:p.context,createdBy:actor,createdAt:now(),...(v2?{purpose:'informational',publicationVersion:2}:{})};
  // remind: 'never', or a re-send interval of 30 minutes to 7 days while the item stays open.
  if(p.remind!==undefined){assert(p.remind==='never'||Number.isSafeInteger(p.remind)&&p.remind>=1800000&&p.remind<=7*86400000,'remind must be "never" or an interval of 30 minutes to 7 days in milliseconds');row.remind=p.remind;}
  if(p.links!==undefined){assert(Array.isArray(p.links)&&p.links.length<=16,'bounded links required');row.links=p.links.map(link=>{boundedText(link.label,'link label',240);boundedText(link.url,'link URL',2048);assert(/^(https?:\/\/|t3-thread:\/\/)/.test(link.url),'unsupported link scheme');return {label:link.label,url:link.url};});}
  if(p.kind==='question'){
    boundedText(p.question,'question',4000);assert(Array.isArray(p.choices)&&p.choices.length>=2&&p.choices.length<=8,'question needs two to eight choices');
    row.choices=p.choices.map(choice=>{id(choice.id,'choice');boundedText(choice.label,'choice label',240);if(choice.description!==undefined)boundedText(choice.description,'choice description',2000);return {id:choice.id,label:choice.label,...(choice.description!==undefined?{description:choice.description}:{})};});
    assert(new Set(row.choices.map(choice=>choice.id)).size===row.choices.length,'question choice ids must be unique');
    const expiryMs=p.expiryMs??86400000;assert(Number.isSafeInteger(expiryMs)&&expiryMs>0&&expiryMs<=7*86400000,'question expiry must be positive and at most seven days');
    Object.assign(row,{question:p.question,answers:row.choices.map(choice=>choice.id),expiresAt:new Date(Date.parse(row.createdAt)+expiryMs).toISOString()});
    row.subjectDigest=digest({projectId:store.meta('project').projectId,...row});
    store.put('wait',{id:`question:${row.id}`,inboxId:row.id,kind:'question',startedAt:row.createdAt,endedAt:null});
  }else assert(p.question===undefined&&p.choices===undefined&&p.expiryMs===undefined,'notices cannot contain question authority');
  store.put('inbox',row);store.event('inbox.published',{inboxId:row.id,kind:row.kind,actor});return row;
}
// A decision-bound card (publication v2). The caller (decision.present) has
// validated the decision; the card carries its exact version and maps each
// choice to a disposition or to a non-resolving reply. It is presentation only:
// expiry, withdrawal, reading or acknowledging it never changes the decision.
export function publishDecisionCard(store,p,actor){
  assert(authorityLedgerEnabled(store),'decision cards need the migrated authority ledger');
  boundedText(p.title,'title',240);boundedText(p.context,'context',16000);boundedText(p.question,'question',4000);
  const inboxId=p.id!==undefined?id(p.id,'inbox id'):uid();assert(!store.get('inbox',inboxId),'inbox id already exists');
  const expiryMs=p.expiryMs??86400000;assert(Number.isSafeInteger(expiryMs)&&expiryMs>0&&expiryMs<=7*86400000,'question expiry must be positive and at most seven days');
  const row={id:inboxId,standalone:true,kind:'question',purpose:'decision',publicationVersion:2,status:'open',role:'operator',version:1,title:p.title,context:p.context,question:p.question,decision:p.decision,choices:p.choices,answers:p.choices.map(choice=>choice.id),createdBy:actor,createdAt:now()};
  if(p.remind!==undefined){assert(p.remind==='never'||Number.isSafeInteger(p.remind)&&p.remind>=1800000&&p.remind<=7*86400000,'remind must be "never" or an interval of 30 minutes to 7 days in milliseconds');row.remind=p.remind;}
  if(p.links!==undefined){assert(Array.isArray(p.links)&&p.links.length<=16,'bounded links required');row.links=p.links.map(link=>{boundedText(link.label,'link label',240);boundedText(link.url,'link URL',2048);assert(/^(https?:\/\/|t3-thread:\/\/)/.test(link.url),'unsupported link scheme');return {label:link.label,url:link.url};});}
  row.expiresAt=new Date(Date.parse(row.createdAt)+expiryMs).toISOString();
  row.subjectDigest=digest({projectId:store.meta('project').projectId,...row});
  store.put('wait',{id:`question:${row.id}`,inboxId:row.id,kind:'question',startedAt:row.createdAt,endedAt:null});
  store.put('inbox',row);store.event('inbox.published',{inboxId:row.id,kind:row.kind,actor,purpose:'decision',decisionId:p.decision.decisionId});return row;
}
export function answerStandaloneInbox(store,item,p,actor,{delegated=false,relayed=null}={}){
  assert(item.standalone&&item.kind==='question','standalone question required');assert(item.purpose!=='decision','a decision card is answered through its decision');assert(actor==='operator'||delegated||item.role===actor,'standalone questions require the operator');
  assertCurrentQuestion(item,{version:p.version,subjectDigest:p.subjectDigest});assert(Date.parse(item.expiresAt)>Date.now(),'question expired');assert(item.answers.includes(p.answer),'invalid answer');
  if(p.note!==undefined)boundedText(p.note,'answer note',4000);
  item.status='answered';item.answer=p.answer;item.answeredBy=actor;item.answeredAt=now();item.version++;if(p.note!==undefined)item.answerNote=p.note;
  recordRelay(store,item,relayed,actor);
  const wait=store.get('wait',`question:${item.id}`);if(wait&&!wait.endedAt)store.put('wait',{...wait,endedAt:item.answeredAt,reason:'answered'});
  store.put('inbox',item);store.event('inbox.answered',{inboxId:item.id,answer:p.answer,actor,standalone:true,...(relayed?{relayed:true,relayedBy:actor,channel:relayed.channel}:{})});return item;
}
// The publisher (or the operator) can withdraw an open standalone item it no
// longer needs answered. Flow questions stay governed by their flows.
export function withdrawStandaloneInbox(store,p,actor){
  const item=store.need('inbox',p.inboxId);
  assert(item.standalone,'only standalone inbox items can be withdrawn; flow questions are resolved through their flow');
  assert(actor==='operator'||actor===item.createdBy,'only the publisher or the operator can withdraw this item');
  assert(item.status==='open'&&item.version===p.expectedVersion,'stale or resolved inbox item');
  boundedText(p.reason,'withdrawal reason',4000);
  item.status='superseded';item.withdrawal={actor,reason:p.reason,at:now(),...(item.purpose==='decision'?{decisionRemains:item.decision.decisionId}:{})};item.version++;
  const wait=store.get('wait',`question:${item.id}`);if(wait&&!wait.endedAt)store.put('wait',{...wait,endedAt:item.withdrawal.at,reason:'withdrawn'});
  store.put('inbox',item);store.event('inbox.withdrawn',{inboxId:item.id,actor,standalone:true});return item;
}
export function expireStandaloneQuestions(store,{nowMs=Date.now()}={}){
  for(const item of store.live('inbox').filter(row=>row.standalone&&row.kind==='question'&&row.status==='open'&&Date.parse(row.expiresAt)<=nowMs)){
    item.status='expired';item.version++;store.put('inbox',item);const wait=store.get('wait',`question:${item.id}`);if(wait&&!wait.endedAt)store.put('wait',{...wait,endedAt:new Date(nowMs).toISOString(),reason:'expired'});store.event('inbox.expired',{inboxId:item.id,standalone:true});
  }
}

// Presentations: a question shown through an external prompt channel as well as the inbox.
// Host-neutral: a channel is a name the presenter chooses (a host's interactive prompt, say);
// the factory never talks to it. The inbox item stays the question. A presentation records
// that the channel is also showing it until a set time. It is never an answer and never
// authority, it leaves the item's version alone (an answer form already open stays valid),
// and it holds nothing: the question can be answered in the inbox at any moment.
// One ends as answered (an answer arrived through it), withdrawn, expired (the time passed;
// the question stays open) or obsolete (the question was resolved another way).
const PRESENTED='presentedInbox'; // ids of inbox items that have a pending presentation
const onlyFields=(p,keys,operation)=>{const extra=Object.keys(p).filter(key=>!keys.includes(key));assert(!extra.length,`${operation} does not accept ${extra.join(', ')}; it accepts ${keys.join(', ')}`);};
// Telling the presenter is best effort: a failure there must never fail the command or tick that ended the presentation.
const tellPresenter=(store,item,row,options)=>{try{wakePresenterInTransaction(store,item,row,options);}catch(error){store.event('inbox.presentation-wake-failed',{inboxId:item.id,presentationId:row.id,error:error.message});}};
const endPresentation=(row,status,endedBy,reason,at)=>Object.assign(row,{status,endedAt:at,endedBy,reason,...(endedBy!==row.presentedBy?{notify:true}:{})});
export function presentInbox(store,p,actor){
  onlyFields(p,['inboxId','expectedVersion','channel','expiryMs','id'],'inbox.present');
  settlePresentations(store);
  const item=store.need('inbox',p.inboxId);
  assert(item.kind==='question','only a question can be presented; a notice asks nothing');
  assertCurrentQuestion(item,{version:p.expectedVersion});
  assert(!item.expiresAt||Date.parse(item.expiresAt)>Date.now(),'question expired');
  boundedText(p.channel,'presentation channel',200);
  const expiryMs=p.expiryMs??900000;assert(Number.isSafeInteger(expiryMs)&&expiryMs>=60000&&expiryMs<=86400000,'presentation expiry must be one minute to one day in milliseconds');
  const rows=item.presentations??[],pending=rows.find(row=>row.status==='pending');
  assert(!pending,`already presented on ${pending?.channel} until ${pending?.expiresAt}; withdraw that presentation first (inbox.unpresent)`);
  assert(rows.length<32,'this question was presented 32 times; leave it in the inbox');
  const presentedAt=now(),ends=Math.min(Date.parse(presentedAt)+expiryMs,item.expiresAt?Date.parse(item.expiresAt):Infinity);
  const row={id:p.id!==undefined?id(p.id,'presentation id'):uid(),channel:p.channel,presentedBy:actor,presentedAt,expiresAt:new Date(ends).toISOString(),status:'pending'};
  assert(!rows.some(other=>other.id===row.id),'presentation id already exists');
  item.presentations=[...rows,row];store.put('inbox',item);store.setMeta(PRESENTED,[...new Set([...store.meta(PRESENTED,[]),item.id])]);
  store.event('inbox.presented',{inboxId:item.id,presentationId:row.id,channel:row.channel,expiresAt:row.expiresAt,actor});
  return {inboxId:item.id,version:item.version,subjectDigest:item.subjectDigest,presentation:row};
}
// The presenter (or the operator) takes a presentation down. The question stays open.
export function withdrawPresentation(store,p,actor){
  onlyFields(p,['inboxId','presentationId','reason'],'inbox.unpresent');
  settlePresentations(store);
  const item=store.need('inbox',p.inboxId),row=(item.presentations??[]).find(other=>other.id===p.presentationId);assert(row,'unknown presentation');
  assert(actor==='operator'||actor===row.presentedBy,'only the presenter or the operator can withdraw this presentation');
  assert(row.status==='pending',`presentation already ${row.status}`);boundedText(p.reason,'withdrawal reason',4000);
  endPresentation(row,'withdrawn',actor,p.reason,now());store.put('inbox',item);
  store.event('inbox.presentation-ended',{inboxId:item.id,presentationId:row.id,channel:row.channel,status:'withdrawn',actor});
  if(row.notify)tellPresenter(store,item,row);
  return {inboxId:item.id,version:item.version,status:item.status,presentation:row};
}
// An open question's card changed materially and its version rose (a merge question whose target
// moved): a pending presentation shows the earlier card, and an answer relayed through it would
// be refused as stale. It ends as obsolete, with the reason, and its presenter is told, exactly
// as when the question is resolved another way; the question stays open, to be presented again
// at its current version. The caller stores the item.
export function endPresentationsForChange(store,item,reason,{nowMs=Date.now()}={}){
  const at=new Date(nowMs).toISOString(),closed=(item.presentations??[]).filter(row=>row.status==='pending').map(row=>endPresentation(row,'obsolete','factory',`the question changed: ${reason}; it stays open in the inbox at version ${item.version}`,at));
  if(!closed.length)return [];
  store.put('inbox',item);
  for(const row of closed){store.event('inbox.presentation-ended',{inboxId:item.id,presentationId:row.id,channel:row.channel,status:row.status,reason:'question changed'});if(row.notify)tellPresenter(store,item,row,{nowMs});}
  return closed;
}
// Settles what the clock and other commands ended: a pending presentation whose time passed
// expires and its question stays open; one whose question was resolved any other way
// (answered in the inbox, withdrawn, expired, superseded with its flow) becomes obsolete.
// Runs after every command and on every operations tick, inside the caller's transaction.
export function settlePresentations(store,{nowMs=Date.now()}={}){
  const ids=store.meta(PRESENTED,[]);if(!ids.length)return [];
  const ended=[],still=[],at=new Date(nowMs).toISOString();
  for(const inboxId of ids){
    const item=store.get('inbox',inboxId);if(!item)continue;
    const resolution=inboxResolution(item),closed=[];
    for(const row of item.presentations??[]){
      if(row.status!=='pending')continue;
      if(resolution)closed.push(endPresentation(row,'obsolete',resolution.actor??'factory',`the question was ${resolution.kind}${resolution.actor?` by the ${resolution.actor}`:''} in the inbox`,at));
      else if(Date.parse(row.expiresAt)<=nowMs)closed.push(endPresentation(row,'expired','factory','no answer arrived through it in time; the question stays open in the inbox',at));
    }
    if(closed.length){
      store.put('inbox',item);
      for(const row of closed){store.event('inbox.presentation-ended',{inboxId:item.id,presentationId:row.id,channel:row.channel,status:row.status});if(row.notify)tellPresenter(store,item,row,{nowMs});ended.push({inboxId:item.id,...row});}
    }
    if((item.presentations??[]).some(row=>row.status==='pending'))still.push(inboxId);
  }
  if(still.length!==ids.length)store.setMeta(PRESENTED,still);
  return ended;
}
// The relay record. An answer that reaches the factory through anyone but the operator is
// relayed: exactly who entered it (the command's actor, never a payload field), the channel
// the operator's words came through, and those words verbatim (the chosen option label and
// any free text). Nothing else is accepted or added. It is provenance only: it grants no
// authority the command did not already have, and it never turns the answer into a direct
// operator answer. An answer through a presentation is always relayed.
export function relayedAnswerInput(item,p,actor){
  if(p.relay===undefined&&p.presentationId===undefined)return null;
  assert(actor!=='operator','the operator answers directly; relay records an answer someone else entered on the operator\'s behalf');
  assert(p.relay!==undefined,'an answer that arrived through a presentation is relayed: send relay {quote, channel}, the operator\'s words verbatim and the channel they came through');
  const relay=p.relay;
  // A decision card's relay is validated and kept by the migrated relayedAnswer rules (core/decisions.mjs).
  if(item.purpose!=='decision'){
    onlyFields(p,['inboxId','version','subjectDigest','answer','note','reviewedHead','relay','presentationId'],'a relayed answer');
    assert(relay&&typeof relay==='object'&&!Array.isArray(relay)&&Object.keys(relay).every(key=>['quote','channel'].includes(key)),'relay is {quote, channel}: the operator\'s words verbatim and where they were said; the relayer is the command\'s actor');
    boundedText(relay.quote,'relay quote (the operator\'s words, verbatim)',4000);boundedText(relay.channel,'relay channel',200);
  }
  let presentation=null;
  if(p.presentationId!==undefined){
    presentation=(item.presentations??[]).find(row=>row.id===p.presentationId);assert(presentation,'unknown presentation');
    const expired=presentation.status==='pending'&&Date.parse(presentation.expiresAt)<=Date.now();
    assert(presentation.status==='pending'&&!expired,`presentation ${presentation.id} is ${expired?'expired':presentation.status}; no answer is accepted through it, and an open question stays in the inbox`);
    assert(relay?.channel===presentation.channel,`relay channel must be the presentation's channel (${presentation.channel})`);
  }
  return {quote:relay?.quote,channel:relay?.channel,presentationId:presentation?.id??null};
}
// Marks the item's presentation answered. The caller stores the item.
export function answerPresentation(store,item,relayed,actor,extra={}){
  if(!relayed?.presentationId)return;
  const row=item.presentations.find(other=>other.id===relayed.presentationId);
  Object.assign(endPresentation(row,'answered',actor,'an answer arrived through it',now()),extra);delete row.notify;
  store.event('inbox.presentation-ended',{inboxId:item.id,presentationId:row.id,channel:row.channel,status:'answered',actor});
}
// Schema-1 relay record on the answered item (also used for informational and flow questions
// of a migrated project; a decision card there keeps the relayedAnswer authority record).
export function recordRelay(store,item,relayed,actor){
  if(!relayed)return;
  item.relay={schemaVersion:1,relayedBy:actor,channel:relayed.channel,quote:relayed.quote,commandId:store.commandId??null,recordedAt:now(),...(relayed.presentationId?{presentationId:relayed.presentationId}:{})};
  answerPresentation(store,item,relayed,actor);
}
