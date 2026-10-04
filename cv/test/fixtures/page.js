// The page's script (web/app.js) run in Node, in a context of its own, over a
// minimal DOM built from web/index.html's ids. It keeps the DOM's rules that
// matter to what the page shows: append and replaceChildren turn anything
// that is not a node into text (null becomes "null", as in a browser), and
// textContent = null empties an element. The server is a function of the
// test's; timers run only when the test says so.

import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const SOURCE = readFileSync(new URL('../../web/app.js', import.meta.url), 'utf8');
const HTML = readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8');

class FakeNode {
  constructor() {
    this.childNodes = [];
  }
}

class FakeText extends FakeNode {
  constructor(data) {
    super();
    this.data = data;
  }

  get textContent() {
    return this.data;
  }
}

const toNode = (value) => (value instanceof FakeNode ? value : new FakeText(String(value)));

class FakeElement extends FakeNode {
  constructor(tag, id = '') {
    super();
    this.tagName = tag.toUpperCase();
    this.id = id;
    this.attributes = {};
    this.dataset = {};
    this.listeners = {};
    this.style = { setProperty: () => {} };
    this.classList = { add: () => {}, remove: () => {} };
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.className = '';
    this.title = '';
  }

  get textContent() {
    return this.childNodes.map((node) => node.textContent).join('');
  }

  set textContent(value) {
    this.childNodes = value === null || value === undefined || value === '' ? [] : [new FakeText(String(value))];
  }

  append(...nodes) {
    this.childNodes.push(...nodes.map(toNode));
  }

  prepend(...nodes) {
    this.childNodes.unshift(...nodes.map(toNode));
  }

  replaceChildren(...nodes) {
    this.childNodes = nodes.map(toNode);
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  addEventListener(type, listener) {
    (this.listeners[type] ??= []).push(listener);
  }

  dispatch(type, event = {}) {
    for (const listener of this.listeners[type] ?? []) listener({ preventDefault() {}, ...event });
  }

  click() {
    this.dispatch('click');
  }

  /** Every element under this one, depth first. */
  *walk() {
    for (const node of this.childNodes) {
      if (node instanceof FakeElement) {
        yield node;
        yield* node.walk();
      }
    }
  }
}

/**
 * Load the page. `server(path, init)` answers each fetch with
 * `{ status, body }` (or a promise of it). Returns the page's elements by id,
 * the fetches made, `settle()` to let pending work finish, `tick()` to fire
 * the timers due, and `close()` to leave every later fetch pending.
 */
export function loadPage(server, { token = 't'.repeat(48) } = {}) {
  const byId = new Map();
  // An element written with the hidden attribute starts hidden, as in a browser.
  for (const match of HTML.matchAll(/<(\w+)([^>]*)>/g)) {
    const id = match[2].match(/\sid="([^"]+)"/)?.[1];
    if (!id) continue;
    const element = new FakeElement(match[1], id);
    element.hidden = /\shidden(?=[\s>]|$)/.test(match[2]);
    byId.set(id, element);
  }
  const document = {
    createElement: (tag) => new FakeElement(tag),
    createTextNode: (data) => new FakeText(String(data)),
    getElementById: (id) => byId.get(id) ?? null,
    querySelector: (selector) => (selector === 'meta[name="csrf-token"]' ? { content: token } : null),
  };
  const fetches = [];
  const timers = [];
  let closed = false;
  const fetch = async (path, init = {}) => {
    if (closed) return new Promise(() => {});
    fetches.push({ path, init });
    const { status = 200, body = {} } = await server(path, init);
    return { ok: status >= 200 && status < 300, status, json: async () => JSON.parse(JSON.stringify(body)) };
  };
  const context = createContext({ document, Node: FakeNode, fetch, console, setTimeout: (fn) => timers.push(fn), clearTimeout: () => {} });
  runInContext(`'use strict';\n${SOURCE}`, context, { filename: 'web/app.js' });
  const settle = async () => {
    for (let i = 0; i < 50; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  return {
    $: (id) => byId.get(id),
    fetches,
    settle,
    async tick() {
      for (const fn of timers.splice(0)) fn();
      await settle();
    },
    close() {
      closed = true;
    },
  };
}
