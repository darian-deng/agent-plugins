/**
 * Pages allowed to go over the inline budget. Over it the engine hands the prompt over as a
 * file and the read lock refuses the main session everything else until it has Read that
 * file whole — nothing is dropped, it costs one Read round-trip per injection. Listing a page
 * is a deliberate act (it trades that round-trip for room); a listed page is still held to
 * what one Read can return whole (`READ_SAFE_CHARS` and the line limits).
 */
export const READ_FALLBACK_OK = new Set<string>([
  // The two pages that kept running out of room: the stage-3 dispatch page carries every
  // red line of the main loop, stage-2 every rule for cutting tickets.
  'grill-flow/stages/stage-2.md',
  'grill-flow/stages/stage-3.md',
]);
