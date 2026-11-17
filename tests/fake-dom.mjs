// A minimal DOM for rendering console views in Node: enough for ui/dom.mjs's h(), text content,
// attributes, classes and event handlers. It is installed on globalThis before any console module
// is imported (ui/state.mjs reads the CSRF meta tag at import). Views are inspected as trees.
export class Element {
  constructor(tag, text = '') {
    this.tag = tag; this.tagName = tag.toUpperCase(); this.children = []; this.handlers = {}; this.dataset = {}; this.attributes = {};
    this.style = { setProperty(key, value) { this[key] = value; } }; this.value = ''; this._text = text; this.className = ''; this.parentElement = null;
  }
  append(...items) {
    for (const item of items.flat(Infinity)) {
      if (item === null || item === undefined || item === false) continue;
      const node = item instanceof Element ? item : new Element('#text', String(item));
      node.parentElement = this; this.children.push(node);
    }
  }
  replaceChildren(...items) { this.children = []; this.append(...items); }
  addEventListener(name, handler) { (this.handlers[name] ??= []).push(handler); }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  getAttribute(key) { return this.attributes[key] ?? null; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  get classList() { return this.className.split(/\s+/).filter(Boolean); }
  contains(node) { for (let n = node; n; n = n.parentElement) if (n === this) return true; return false; }
  closest(selector) { for (let node = this; node; node = node.parentElement) if (node.tag === selector) return node; return null; }
  reportValidity() { return true; }
  focus() { globalThis.document.activeElement = this; }
}
const storage = () => { const map = new Map(); return { getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, String(value)), removeItem: key => map.delete(key) }; };

export function installDom() {
  const keys = ['Node', 'document', 'localStorage', 'sessionStorage', 'window', 'fetch'], old = Object.fromEntries(keys.map(key => [key, globalThis[key]]));
  Object.assign(globalThis, {
    Node: Element, localStorage: storage(), sessionStorage: storage(),
    document: { querySelector: () => ({ content: 'fixture-csrf' }), createElement: tag => new Element(tag), createElementNS: (_ns, tag) => new Element(tag), createTextNode: text => new Element('#text', text), body: new Element('body'), documentElement: new Element('html'), getElementById: () => null, activeElement: null },
    window: { dispatchEvent() {}, addEventListener() {}, confirm: () => true },
    fetch: async () => ({ ok: false, status: 404, json: async () => ({ error: 'artifact not available' }) }),
  });
  return () => { for (const [key, value] of Object.entries(old)) if (value === undefined) delete globalThis[key]; else globalThis[key] = value; };
}
export const descendants = node => [node, ...node.children.flatMap(child => child instanceof Element ? descendants(child) : [])];
export const byClass = (node, cls) => descendants(node).filter(n => n.classList.includes(cls));
export const byTag = (node, tag) => descendants(node).filter(n => n.tag === tag);
export const withText = (node, tag, pattern) => byTag(node, tag).filter(n => pattern instanceof RegExp ? pattern.test(n.textContent) : n.textContent === pattern);
export const click = async node => { for (const handler of node.handlers.click ?? []) await handler({ currentTarget: node, target: node, preventDefault() {} }); };
