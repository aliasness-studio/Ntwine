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
