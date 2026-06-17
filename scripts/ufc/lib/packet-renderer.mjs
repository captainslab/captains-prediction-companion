function section(title) {
  return `=== ${title} ===`;
}

export function renderUfcPacket({ cardTitle, date, card, sources = [] }) {
  const fights = card?.fights || [];
  const lines = [];
  lines.push(`=== UFC Composite Packet: ${cardTitle} ===`);
  lines.push(`date: ${date}`);
  if (sources.length) lines.push(`sources: ${sources.join(' | ')}`);
  lines.push('');
  lines.push(`Fights: ${fights.length}`);
  lines.push('');
  for (const fight of fights) {
    lines.push(`--- ${fight.fighter_a_name} vs ${fight.fighter_b_name} ---`);
    if (Array.isArray(fight.market_context?.lane_events) && fight.market_context.lane_events.length > 0) {
      const laneNames = fight.market_context.lane_events.map((entry) => `${entry.lane}(${entry.market_count})`).join(', ');
      lines.push(`  captured lanes: ${laneNames}`);
    }
    lines.push(`  winner: ${fight.favored} (${fight.posture}) edge=${fight.edge_score}`);
    lines.push(`  round of victory: ${fight.lanes.round_of_victory.lean} (${fight.lanes.round_of_victory.confidence}) — early:${fight.lanes.round_of_victory.early} mid:${fight.lanes.round_of_victory.mid} late:${fight.lanes.round_of_victory.late}`);
    lines.push(`  round of finish: ${fight.lanes.round_of_finish.lean} (${fight.lanes.round_of_finish.confidence}) — early:${fight.lanes.round_of_finish.early} mid:${fight.lanes.round_of_finish.mid} late:${fight.lanes.round_of_finish.late}`);
    lines.push(`  method of finish: ${fight.lanes.method_of_finish.method} (${fight.lanes.method_of_finish.confidence}) — KO:${fight.lanes.method_of_finish.ko_tko} SUB:${fight.lanes.method_of_finish.submission} DEC:${fight.lanes.method_of_finish.decision}`);
    lines.push('');
  }
  return lines.join('\n');
}

export function renderUfcInventory({ cardTitle, date, card, kalshiEvents = [] }) {
  const fights = card?.fights || [];
  const lines = [];
  lines.push(`=== UFC Inventory: ${cardTitle} ===`);
  lines.push(`date: ${date}`);
  lines.push('');
  for (const fight of fights) {
    lines.push(`  ${fight.fighter_a_name} vs ${fight.fighter_b_name}:`);
    if (Array.isArray(fight.market_context?.lane_events) && fight.market_context.lane_events.length > 0) {
      const laneNames = fight.market_context.lane_events.map((entry) => `${entry.lane}(${entry.market_count})`).join(', ');
      lines.push(`    captured lanes: ${laneNames}`);
      lines.push('    raw bid/ask/last/volume/OI: inventory artifact only');
    } else {
      lines.push('    captured lanes: none');
    }
    lines.push('');
  }
  return lines.join('\n');
}
