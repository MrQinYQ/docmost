import type { SpaceTreeNode } from "@/features/page/tree/types";
import { treeModel } from "@/features/page/tree/model/tree-model";

export function reconcileToolPage(
  tree: SpaceTreeNode[],
  page: Record<string, unknown>,
): SpaceTreeNode[] {
  if (
    typeof page.id !== "string" ||
    typeof page.spaceId !== "string" ||
    typeof page.position !== "string"
  )
    return tree;
  const old = treeModel.find(tree, page.id);
  const spaceId = page.spaceId;
  function inSpace(nodes: SpaceTreeNode[]): SpaceTreeNode[] {
    return nodes.map((node) => ({
      ...node,
      spaceId,
      children: inSpace(node.children ?? []),
    }));
  }
  const parentId =
    typeof page.parentPageId === "string" ? page.parentPageId : null;
  const parent = parentId ? treeModel.find(tree, parentId) : null;
  const parentIsUnloaded = parent?.hasChildren && !parent.children?.length;
  const node: SpaceTreeNode = {
    ...old,
    id: page.id,
    slugId: typeof page.slugId === "string" ? page.slugId : old?.slugId,
    name: typeof page.title === "string" ? page.title : (old?.name ?? ""),
    icon: typeof page.icon === "string" ? page.icon : old?.icon,
    position: page.position,
    spaceId,
    parentPageId: parentId,
    hasChildren:
      typeof page.hasChildren === "boolean"
        ? page.hasChildren
        : (old?.hasChildren ?? false),
    children:
      old?.spaceId === spaceId
        ? (old?.children ?? [])
        : inSpace(old?.children ?? []),
  };
  let next = treeModel.remove(tree, page.id);
  // Empty children + hasChildren means the branch has not been fetched yet.
  // A partial insertion would suppress SpaceTree's fetch on first expansion.
  if (parentIsUnloaded)
    return treeModel.update(next, parentId, { hasChildren: true });
  const siblings = parentId
    ? (treeModel.find(next, parentId)?.children ?? [])
    : next;
  const index = siblings.findIndex(
    (sibling) =>
      sibling.spaceId === spaceId && sibling.position > node.position,
  );
  next = treeModel.insert(next, parentId, node, index < 0 ? undefined : index);
  if (parentId) next = treeModel.update(next, parentId, { hasChildren: true });
  return next;
}
