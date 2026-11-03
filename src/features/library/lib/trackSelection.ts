/**
 * Pure selection helpers for the playlist page's multi-select mode
 * (upstream harvest Wave 3, Rank 10 remainder — the multi-select Idea).
 *
 * A selection is a set of row keys (playlistItemId when the row has
 * one, otherwise the track id). Range selection works over the keys
 * in visible order, which is exactly what the virtualised list renders.
 */

export function trackSelectionKey(track: {
  id: string;
  playlistItemId?: string;
}): string {
  return track.playlistItemId ?? track.id;
}

export function toggleSelectionKey(
  selected: ReadonlySet<string>,
  key: string,
): Set<string> {
  const next = new Set(selected);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

/**
 * Add (or, when `select` is false, remove) every key between anchor
 * and target inclusive, in visible order. Unknown anchors/targets
 * degrade to toggling just the target.
 */
export function applyRangeSelection(
  selected: ReadonlySet<string>,
  orderedKeys: readonly string[],
  anchorKey: string | null,
  targetKey: string,
  select: boolean,
): Set<string> {
  const next = new Set(selected);
  const anchorIndex = anchorKey ? orderedKeys.indexOf(anchorKey) : -1;
  const targetIndex = orderedKeys.indexOf(targetKey);
  if (anchorIndex === -1 || targetIndex === -1) {
    if (select) next.add(targetKey);
    else next.delete(targetKey);
    return next;
  }
  const [from, to] =
    anchorIndex <= targetIndex
      ? [anchorIndex, targetIndex]
      : [targetIndex, anchorIndex];
  for (let index = from; index <= to; index += 1) {
    if (select) next.add(orderedKeys[index]);
    else next.delete(orderedKeys[index]);
  }
  return next;
}
