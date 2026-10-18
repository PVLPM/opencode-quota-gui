import { createMemo, createRenderEffect, splitProps, untrack } from "solid-js";
import type { TestNode } from "./gui-test-renderer.js";
import { createElement, insert, setProp } from "./gui-test-renderer.js";

/**
 * `solid-js/web` with one DOM-free change for the universal render rig.
 *
 * The client build is re-exported wholesale — its module top level never
 * touches the DOM — and local exports shadow the star re-export. Only
 * `Dynamic` needs a different body: the real one builds a DOM element for a
 * string tag, which this rig has no DOM for. Kobalte's `Polymorphic` uses
 * `Dynamic` for every element wrapper, so it is reimplemented against the
 * fixture renderer: a component runs directly and a string tag becomes a
 * renderer element with its children and props applied the way compiled JSX
 * would apply them.
 */
export * from "../../node_modules/solid-js/web/dist/web.js";

export interface DynamicProps {
  component?: unknown;
  [key: string]: unknown;
}

export function Dynamic(props: DynamicProps): () => unknown {
  const [local, others] = splitProps(props, ["component"]);
  return createMemo(() => {
    const component = local.component;
    if (typeof component === "function") {
      return untrack(() => (component as (componentProps: unknown) => unknown)(others));
    }
    if (typeof component === "string") return dynamicElement(component, others);
    return undefined;
  });
}

function dynamicElement(tag: string, props: Record<string, unknown>): TestNode {
  const node = createElement(tag);
  createRenderEffect(() => {
    for (const key of Object.keys(props)) {
      if (key === "children") continue;
      setProp(node, key, props[key]);
    }
  });
  if (props.children !== undefined) insert(node, props.children);
  return node;
}
