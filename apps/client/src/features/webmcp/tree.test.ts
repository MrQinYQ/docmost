import { describe, expect, it } from "vitest";
import { reconcileToolPage } from "./tree";
import type { SpaceTreeNode } from "@/features/page/tree/types";

const node = (
  id: string,
  parentPageId: string | null = null,
): SpaceTreeNode => ({
  id,
  slugId: id,
  name: id,
  position: "a00000",
  spaceId: "space",
  parentPageId,
  hasChildren: false,
  children: [],
});

describe("WebMCP lazy sidebar branches", () => {
  it("keeps an unloaded existing branch empty so expansion still fetches every child", () => {
    const parent = { ...node("parent"), hasChildren: true, children: [] };
    const tree = reconcileToolPage([parent], {
      id: "new",
      slugId: "new",
      title: "New",
      position: "a00001",
      parentPageId: "parent",
      spaceId: "space",
    });
    expect(tree[0].children).toEqual([]);
    expect(tree[0].hasChildren).toBe(true);
  });

  it("does not turn an unloaded move destination into a partial branch", () => {
    const child = node("child", "source");
    const tree = reconcileToolPage(
      [
        { ...node("source"), children: [child], hasChildren: true },
        { ...node("destination"), hasChildren: true },
      ],
      {
        id: "child",
        slugId: "child",
        title: "Moved",
        position: "a00001",
        parentPageId: "destination",
        spaceId: "space",
      },
    );
    expect(tree[0].children).toEqual([]);
    expect(tree[1].children).toEqual([]);
    expect(tree[1].hasChildren).toBe(true);
  });
  it("inserts a newly created page into an already loaded parent", () => {
    const parent = {
      ...node("parent"),
      children: [node("existing", "parent")],
    };
    const tree = reconcileToolPage([parent], {
      id: "new",
      slugId: "new",
      title: "New",
      position: "a00001",
      parentPageId: "parent",
      spaceId: "space",
    });
    expect(tree[0].children.map((child) => child.id)).toEqual([
      "existing",
      "new",
    ]);
    expect(tree[0].hasChildren).toBe(true);
  });

  it("moves a loaded subtree to its new parent without losing descendants", () => {
    const child = {
      ...node("child", "source"),
      children: [node("grandchild", "child")],
      hasChildren: true,
    };
    const roots = [
      { ...node("source"), children: [child], hasChildren: true },
      node("destination"),
    ];
    const tree = reconcileToolPage(roots, {
      id: "child",
      slugId: "child",
      title: "Moved",
      parentPageId: "destination",
      position: "a00001",
      spaceId: "space",
    });
    expect(tree[0].children).toEqual([]);
    expect(tree[1].children[0]).toMatchObject({
      id: "child",
      name: "Moved",
      children: [{ id: "grandchild" }],
    });
    expect(tree[1].hasChildren).toBe(true);
  });

  it("updates loaded descendants when moving a subtree to a different space", () => {
    const child = { ...node("child"), children: [node("grandchild", "child")] };
    const tree = reconcileToolPage([child], {
      id: "child",
      slugId: "child",
      title: "Moved",
      parentPageId: null,
      position: "a00001",
      spaceId: "new-space",
    });
    expect(tree[0].spaceId).toBe("new-space");
    expect(tree[0].children[0].spaceId).toBe("new-space");
  });
});
