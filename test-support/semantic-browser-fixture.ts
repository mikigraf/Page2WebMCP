export type FixtureTool = {
  name: string;
  title: string;
  execute(input: unknown, context: { signal: AbortSignal }): Promise<unknown>;
};

type FixtureDocumentFactory = (markup: string) => FixtureDocument;

export class FixtureHTMLElement extends EventTarget {
  readonly attributes = new Map<string, string>();
  readonly children: FixtureHTMLElement[] = [];
  parentElement: FixtureHTMLElement | null = null;
  ownerDocument?: FixtureDocument;
  textContent = "";
  disabled = false;
  nativeClickCalls = 0;

  constructor(readonly tagName: string) {
    super();
  }

  append(...children: FixtureHTMLElement[]) {
    for (const child of children) {
      child.parentElement = this;
      child.attachDocument(this.ownerDocument);
      this.children.push(child);
    }
  }

  attachDocument(documentObject?: FixtureDocument) {
    this.ownerDocument = documentObject;
    for (const child of this.children) child.attachDocument(documentObject);
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }

  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }

  hasAttribute(name: string) {
    return this.attributes.has(name);
  }

  remove() {
    if (!this.parentElement) return;
    const index = this.parentElement.children.indexOf(this);
    if (index >= 0) this.parentElement.children.splice(index, 1);
    this.parentElement = null;
  }

  contains(target: FixtureHTMLElement): boolean {
    return target === this || this.children.some((child) => child.contains(target));
  }

  getElementsByTagName(tagName: string): FixtureHTMLElement[] {
    const normalized = tagName.toUpperCase();
    const matches: FixtureHTMLElement[] = [];
    for (const child of this.children) {
      if (normalized === "*" || child.tagName === normalized) matches.push(child);
      matches.push(...child.getElementsByTagName(normalized));
    }
    return matches;
  }

  get isConnected() {
    return this.ownerDocument?.body.contains(this) ?? false;
  }

  click() {
    this.nativeClickCalls += 1;
    this.dispatchEvent(new Event("click", { bubbles: true }));
  }
}

export class FixtureInputElement extends FixtureHTMLElement {
  #value = "";
  #checked = false;
  nativeValueSetterCalls = 0;
  nativeCheckedSetterCalls = 0;

  constructor() {
    super("INPUT");
  }

  get value() {
    return this.#value;
  }

  set value(value: string) {
    this.nativeValueSetterCalls += 1;
    this.#value = String(value);
  }

  get checked() {
    return this.#checked;
  }

  set checked(value: boolean) {
    this.nativeCheckedSetterCalls += 1;
    this.#checked = Boolean(value);
  }

  get type() {
    return this.getAttribute("type") ?? "text";
  }

  set type(value: string) {
    this.setAttribute("type", value);
  }
}

export class FixtureTextAreaElement extends FixtureHTMLElement {
  #value = "";
  nativeValueSetterCalls = 0;

  constructor() {
    super("TEXTAREA");
  }

  get value() {
    return this.#value;
  }

  set value(value: string) {
    this.nativeValueSetterCalls += 1;
    this.#value = String(value);
  }
}

export class FixtureSelectElement extends FixtureHTMLElement {
  #value = "";
  nativeValueSetterCalls = 0;

  constructor() {
    super("SELECT");
  }

  get value() {
    return this.#value;
  }

  set value(value: string) {
    this.nativeValueSetterCalls += 1;
    this.#value = String(value);
  }
}

export class FixtureOutputElement extends FixtureHTMLElement {
  #value = "";

  constructor() {
    super("OUTPUT");
  }

  get value() {
    return this.#value;
  }

  set value(value: string) {
    this.#value = String(value);
  }
}

export class FixtureDocument {
  readonly body = new FixtureHTMLElement("BODY");
  modelContext?: {
    registerTool(tool: FixtureTool, options: { signal: AbortSignal }): Promise<void>;
  };

  constructor(readonly baseURI: string) {
    this.body.attachDocument(this);
  }

  createElement(tagName: string): FixtureHTMLElement {
    switch (tagName.toLowerCase()) {
      case "input": return new FixtureInputElement();
      case "textarea": return new FixtureTextAreaElement();
      case "select": return new FixtureSelectElement();
      case "output": return new FixtureOutputElement();
      default: return new FixtureHTMLElement(tagName.toUpperCase());
    }
  }

  getElementsByTagName(tagName: string) {
    const normalized = tagName.toUpperCase();
    return [
      ...(normalized === "*" || this.body.tagName === normalized ? [this.body] : []),
      ...this.body.getElementsByTagName(normalized),
    ];
  }

  getElementById(id: string) {
    return this.getElementsByTagName("*").find((element) => element.getAttribute("id") === id) ?? null;
  }
}

export class SemanticBrowserFixture {
  readonly tools: FixtureTool[] = [];
  readonly events = new EventTarget();
  readonly location: { origin: string; href: string };
  readonly document: FixtureDocument;
  parsedDocumentFactory: FixtureDocumentFactory = () => new FixtureDocument(this.location.href);
  private restoreCallbacks: Array<() => void> = [];

  constructor(readonly origin = "https://catalog.example", path = "/workspace") {
    this.location = { origin, href: `${origin}${path}` };
    this.document = new FixtureDocument(this.location.href);
    this.document.modelContext = {
      registerTool: async (tool, { signal }) => {
        this.tools.push(tool);
        signal.addEventListener("abort", () => {
          const index = this.tools.indexOf(tool);
          if (index >= 0) this.tools.splice(index, 1);
        }, { once: true });
      },
    };
  }

  element(tagName: string, attributes: Record<string, string> = {}, textContent = "") {
    const element = this.document.createElement(tagName);
    for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
    element.textContent = textContent;
    return element;
  }

  responseDocument(build: (documentObject: FixtureDocument) => void) {
    this.parsedDocumentFactory = () => {
      const documentObject = new FixtureDocument(this.location.href);
      build(documentObject);
      return documentObject;
    };
  }

  install(options: { confirmationName?: string; confirm?: (request: unknown) => boolean | Promise<boolean> } = {}) {
    const parseResponseDocument = (markup: string) => this.parsedDocumentFactory(markup);
    class FixtureDOMParser {
      parseFromString(markup: string) {
        return parseResponseDocument(markup);
      }
    }
    const globals: Record<string, unknown> = {
      window: Object.assign(this.events, { location: this.location }),
      document: this.document,
      HTMLElement: FixtureHTMLElement,
      HTMLInputElement: FixtureInputElement,
      HTMLTextAreaElement: FixtureTextAreaElement,
      HTMLSelectElement: FixtureSelectElement,
      HTMLOutputElement: FixtureOutputElement,
      DOMParser: FixtureDOMParser,
      [options.confirmationName ?? "__page2webmcpConfirmCatalog"]: options.confirm ?? (async () => true),
    };
    for (const [name, value] of Object.entries(globals)) {
      const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
      Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
      this.restoreCallbacks.push(() => {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete (globalThis as Record<string, unknown>)[name];
      });
    }
    return this;
  }

  restore() {
    for (const callback of this.restoreCallbacks.reverse()) callback();
    this.restoreCallbacks.length = 0;
  }
}
