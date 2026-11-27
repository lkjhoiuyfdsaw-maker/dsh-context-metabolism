// Operates on one session's request entries. The caller supplies settled turns only.
export function projectResults(entries, currentTurn, settlements) {
  const toolResults = new Map(entries
    .filter(entry => entry.message.role === 'tool' && entry.message.source?.kind === 'tool')
    .map(entry => [entry.seq, entry]));
  const settled = new Map();
  for (const settlement of settlements) {
    const { turn, keep } = settlement;
    if (!Number.isSafeInteger(turn) || turn < 1 || turn >= currentTurn) continue;
    if (settled.has(turn)) {
      settled.set(turn, null);
      continue;
    }
    const marks = new Set();
    const valid = Array.isArray(keep) && keep.every(mark => {
      const entry = toolResults.get(mark?.seq);
      if (!entry || entry.turn > turn || typeof mark.reason !== 'string' || !mark.reason.trim()) return false;
      if (marks.has(mark.seq)) return false;
      marks.add(mark.seq);
      return true;
    });
    settled.set(turn, valid ? marks : null);
  }

  // Skipped or invalid settlements leave the last valid marks in effect.
  let latestSettledTurn = 0;
  for (const [turn, marks] of settled) {
    if (marks && turn > latestSettledTurn) latestSettledTurn = turn;
  }
  if (latestSettledTurn === 0) return entries;
  const activeMarks = settled.get(latestSettledTurn);
  return entries.map(entry => {
    if (toolResults.get(entry.seq) !== entry || !settled.get(entry.turn) || activeMarks.has(entry.seq)) return entry;
    return {
      ...entry,
      message: {
        ...entry.message,
        content: [{ type: 'text', text: `[原始工具结果见会话事件 ${entry.seq}]` }],
      },
    };
  });
}
