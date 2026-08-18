// Keyboard-nav snap scroll (QoL round 1): when an arrow key lands the selection on a row that
// isn't FULLY inside the list viewport, SampleList scrolls so that row becomes the top row (the
// Splice "paging" feel) via the virtualizer's scrollToIndex(align: 'start'). This module is only
// the visibility decision — pure math over the scroll geometry, so it unit-tests without a DOM.
// Rows are fixed-height (SampleRow.ROW_HEIGHT), which is what makes `rowIndex * rowHeight` the
// row's exact offset.
export function isRowFullyVisible(
  scrollTop: number,
  viewportHeight: number,
  rowIndex: number,
  rowHeight: number,
): boolean {
  const rowTop = rowIndex * rowHeight;
  const rowBottom = rowTop + rowHeight;
  return rowTop >= scrollTop && rowBottom <= scrollTop + viewportHeight;
}

// Task 11 fix round 1 (design spec §5.3, reviewer finding): a tags/collection popover renders
// just below its anchor row (`top = (rowIndex + 1) * rowHeight` — the row's own bottom edge, the
// same coordinate space `isRowFullyVisible` above already uses for this fixed-height list) — this
// decides whether that popover fits ENTIRELY inside the current viewport without any scrolling.
// SampleList calls this when a popover opens and, when it returns false, snaps the anchor row to
// the top of the viewport (`scrollToIndex(rowIndex, { align: 'start' })`) — the exact 'start'-
// alignment snap keyboard nav already uses via `isRowFullyVisible` — so the popover gets the most
// room below it this viewport can offer. Requiring the row's OWN top (`popoverTop`, its bottom
// edge) to be `>= scrollTop` too, not just the popover's bottom to fit, means a row scrolled
// entirely above the viewport never counts as "fits" either — the primary bug this fixes is a
// popover past the BOTTOM fold, but the same geometry answers "is any of this actually visible"
// either direction, for free.
export function doesPopoverFitBelowRow(
  scrollTop: number,
  viewportHeight: number,
  rowIndex: number,
  rowHeight: number,
  popoverHeight: number,
): boolean {
  const popoverTop = (rowIndex + 1) * rowHeight;
  const popoverBottom = popoverTop + popoverHeight;
  return popoverTop >= scrollTop && popoverBottom <= scrollTop + viewportHeight;
}
