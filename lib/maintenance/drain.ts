/** Batches stay small; a cooperative deadline bounds admission of more work. */
export async function drainBatches(
  batch: () => Promise<number>,
  deadline: number,
): Promise<number> {
  let total = 0;
  while (Date.now() < deadline) {
    const processed = await batch();
    total += processed;
    if (!processed) break;
  }
  return total;
}
