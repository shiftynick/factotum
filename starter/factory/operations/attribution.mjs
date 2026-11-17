import {assert} from '../core/contracts.mjs';
export function validateModelCoauthor(config){
  const value=config.workspace?.modelCoauthor;if(value===undefined)return;
  assert(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>['name','email'].includes(key)),'invalid model coauthor configuration');
  assert(typeof value.name==='string'&&value.name.trim()&&value.name.length<=200&&!/[\r\n<>]/.test(value.name),'invalid model coauthor name');
  assert(!/[{}]/.test(value.name.replaceAll('{provider}','').replaceAll('{model}','')),'unsupported model coauthor template');
  assert(typeof value.email==='string'&&value.email.length<=254&&/^[^\s<>@{}]+@[^\s<>@{}]+\.[^\s<>@{}]+$/.test(value.email),'invalid model coauthor email');
}
export function modelCoauthorTrailer(config,receipt){
  validateModelCoauthor(config);const value=config.workspace?.modelCoauthor;if(!value)return '';
  assert(receipt?.provider&&receipt?.model,'model attribution requires actual builder receipt');
  const name=value.name.replaceAll('{provider}',receipt.provider).replaceAll('{model}',receipt.model).trim();
  assert(name.length<=300&&!/[\r\n<>]/.test(name),'invalid actual model attribution');
  return `Co-Authored-By: ${name} <${value.email}>`;
}
