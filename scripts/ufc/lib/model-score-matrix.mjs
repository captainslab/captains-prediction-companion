function compactScores(scores) {
  return Object.entries(scores || {})
    .map(([k, v]) => `${k}:${v ?? 'MISSING'}`)
    .join(' ');
}

function fighterModel(fight, side) {
  const isA = side === 'a';
  const ledger = isA ? fight.fighter_a_ledger : fight.fighter_b_ledger;
  return {
    fighter: isA ? fight.fighter_a_name : fight.fighter_b_name,
    composite_score: isA ? fight.fighter_a_score : fight.fighter_b_score,
    posture: isA ? fight.fighter_a_posture : fight.fighter_b_posture,
    layers_present: isA ? fight.fighter_a_layers : fight.fighter_b_layers,
    layers_total: ledger?.source_quality ? 11 : null,
    layer_scores: Object.fromEntries(Object.entries(ledger || {}).filter(([k]) => !k.startsWith('_') && k !== 'profile' && k !== 'source_quality').map(([k, v]) => [k, v?.score ?? null])),
  };
}

export function renderUfcModelScores({ cardTitle, date, card }) {
  const fights = card?.fights || [];
  const lines = [];
  lines.push(`=== UFC Model Score Matrix: ${cardTitle} ===`);
  lines.push(`date: ${date}`);
  lines.push('');
  for (const fight of fights) {
    lines.push(`--- Fight: ${fight.fighter_a_name} vs ${fight.fighter_b_name} ---`);
    for (const fighter of [fighterModel(fight, 'a'), fighterModel(fight, 'b')]) {
      lines.push(`  fighter_composite: ${fighter.fighter} score=${fighter.composite_score ?? 'MISSING'} posture=${fighter.posture} layers=${fighter.layers_present}/${fighter.layers_total ?? 'MISSING'}`);
      lines.push(`    layer_scores: ${compactScores(fighter.layer_scores)}`);
    }
    lines.push(`  winner_model: ${fight.lanes.winner.lean} | ${fight.fighter_a_name}=${fight.fighter_a_score ?? 'MISSING'} ${fight.fighter_b_name}=${fight.fighter_b_score ?? 'MISSING'} edge=${fight.edge_score} posture=${fight.posture}`);
    lines.push(`  win_path_model: ${fight.fighter_a_name}=pressure:${fight.fighter_a_win_path?.strength ?? 'MISSING'}; ${fight.fighter_b_name}=pressure:${fight.fighter_b_win_path?.strength ?? 'MISSING'}`);
    lines.push(`  counter_risk_model: ${fight.fighter_a_name}=counter:${fight.fighter_a_counter_risk?.severity ?? 'MISSING'}; ${fight.fighter_b_name}=counter:${fight.fighter_b_counter_risk?.severity ?? 'MISSING'}`);
    lines.push(`  method_of_victory_model: pick=${fight.lanes.method_of_victory.method} pick_score=${fight.lanes.method_of_victory.confidence ?? 'MISSING'} scores=${compactScores({ ko_tko: fight.lanes.method_of_victory.ko_tko, submission: fight.lanes.method_of_victory.submission, decision: fight.lanes.method_of_victory.decision })}`);
    lines.push(`  go_the_distance_model: pick=${fight.lanes.go_the_distance.goes_distance} pick_score=${fight.lanes.go_the_distance.confidence ?? 'MISSING'} scores=${compactScores({ yes: fight.lanes.go_the_distance.yes, no: fight.lanes.go_the_distance.no })}`);
    lines.push(`  round_of_victory_model: pick=${fight.lanes.round_of_victory.lean} pick_score=${fight.lanes.round_of_victory.confidence ?? 'MISSING'} scores=${compactScores({ early: fight.lanes.round_of_victory.early, mid: fight.lanes.round_of_victory.mid, late: fight.lanes.round_of_victory.late })}`);
    lines.push(`  round_of_finish_model: pick=${fight.lanes.round_of_finish.lean} pick_score=${fight.lanes.round_of_finish.confidence ?? 'MISSING'} scores=${compactScores({ early: fight.lanes.round_of_finish.early, mid: fight.lanes.round_of_finish.mid, late: fight.lanes.round_of_finish.late })}`);
    lines.push(`  method_of_finish_model: pick=${fight.lanes.method_of_finish.method} pick_score=${fight.lanes.method_of_finish.confidence ?? 'MISSING'} scores=${compactScores({ ko_tko: fight.lanes.method_of_finish.ko_tko, submission: fight.lanes.method_of_finish.submission, decision: fight.lanes.method_of_finish.decision })}`);
    lines.push('');
  }
  return lines.join('\n');
}

