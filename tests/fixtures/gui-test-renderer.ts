import { createRenderer } from "solid-js/universal";

/**
 * The in-memory renderer the render tests run the real components on
 * (design spec §10 "States").
 *
 * The SSR harness can only ever see one snapshot, so it cannot catch a section
 * that renders once and then stops following its payload. `solid-js/universal`
 * lets the real components run on the real reactive runtime while the output
 * stays plain objects, so a test can change a payload and assert what the
 * section renders *next* — no browser and no DOM package needed.
 */

export interface TestNode {
  kind: "element" | "text";
  tag: string;
  props: Record<string, unknown>;
  text: string;
  parent: TestNode | undefined;
  children: TestNode[];
}

function elementNode(tag: string): TestNode {
  return { kind: "element", tag, props: {}, text: "", parent: undefined, children: [] };
}

function textNode(value: string): TestNode {
  return { kind: "text", tag: "", props: {}, text: value, parent: undefined, children: [] };
}

const renderer = createRenderer<TestNode>({
  createElement: (tag) => elementNode(tag),
  createTextNode: (value) => textNode(value),
  isTextNode: (node) => node.kind === "text",
  replaceText: (node, value) => {
    node.text = value;
  },
  insertNode: (parent, node, anchor) => {
    node.parent = parent;
    const index = anchor === undefined ? -1 : parent.children.indexOf(anchor);
    if (index < 0) parent.children.push(node);
    else parent.children.splice(index, 0, node);
  },
  removeNode: (parent, node) => {
    const index = parent.children.indexOf(node);
    if (index >= 0) parent.children.splice(index, 1);
    if (node.parent === parent) node.parent = undefined;
  },
  setProperty: (node, name, value) => {
    node.props[name] = value;
  },
  getParentNode: (node) => node.parent,
  getFirstChild: (node) => node.children[0],
  getNextSibling: (node) => {
    const parent = node.parent;
    if (parent === undefined) return undefined;
    const index = parent.children.indexOf(node);
    return index < 0 ? undefined : parent.children[index + 1];
  },
});

/** A fresh root node; the rendered tree hangs off its `children`. */
export function createTestRoot(): TestNode {
  return elementNode("root");
}

/**
 * The surface the universally-compiled components import from this module
 * (`generate: "universal"` + this file as `moduleName`).
 */
export const {
  effect,
  memo,
  createComponent,
  createElement,
  createTextNode,
  insert,
  insertNode,
  setProp,
  spread,
  mergeProps,
  use,
} = renderer;

/** Mounts `code` under `root`; the returned disposer tears the reactive tree down. */
export const mountTestTree = renderer.render;

/** Everything a reader would see, in document order. */
export function textOf(node: TestNode): string {
  if (node.kind === "text") return node.text;
  return node.children.map((child) => textOf(child)).join("");
}

/** Every rendered node with the given tag, in document order. */
export function elementsNamed(node: TestNode, tag: string): TestNode[] {
  const found = node.kind === "element" && node.tag === tag ? [node] : [];
  for (const child of node.children) found.push(...elementsNamed(child, tag));
  return found;
}
