import { avg, clamp, LAYER_DEFS } from './evidence-ledger.mjs';

function layerScore(entry, key) {
  return Number(entry?.[key]?.score ?? entry?.[key] ?? null);
}

function shapeScore(fighterA, fighterB, key) {
  const a = layerScore(fighterA, key);
  const b = layerScore(fighterB, key);
  if (a === null || b === null || Number.isNaN(a) || Number.isNaN(b)) return null;
  return clamp((a + (100 - b)) / 2);
}

function fightShape(fighterA, fighterB) {
  const aFinish = layerScore(fighterA, 'finish_power');
  const bFinish = layerScore(fighterB, 'finish_power');
  const aDur = layerScore(fighterA, 'durability');
  const bDur = layerScore(fighterB, 'durability');
  const cardio = avg([layerScore(fighterA, 'cardio_pace'), layerScore(fighterB, 'cardio_pace')]);
  const physical = avg([layerScore(fighterA, 'physical_style'), layerScore(fighterB, 'physical_style')]);
  const finishThreat = avg([aFinish, bFinish]) ?? 50;
  const durabilityRisk = 100 - (avg([aDur, bDur]) ?? 50);

  const goesDistance = clamp(100 - finishThreat + durabilityRisk * 0.25 + (cardio ?? 50) * 0.15);
  const roundOfVictory = clamp(finishThreat * 0.45 + durabilityRisk * 0.15 + (cardio ?? 50) * 0.1);
  const roundOfFinish = clamp(finishThreat * 0.4 + durabilityRisk * 0.2 + (physical ?? 50) * 0.05);
  const methodOfFinish = clamp(finishThreat * 0.5 + (aFinish + bFinish) / 4);

  return {
    winner: { lean: null },
    method_of_victory: {
      method: finishThreat >= 60 ? (aFinish >= bFinish ? 'KO/TKO' : 'SUB') : 'DECISION',
      confidence: clamp(finishThreat),
      ko_tko: finishThreat,
      submission: finishThreat * 0.75,
      decision: goesDistance,
    },
    go_the_distance: {
      goes_distance: goesDistance >= 55 ? 'YES' : 'NO',
      confidence: clamp(goesDistance),
      yes: goesDistance,
      no: 100 - goesDistance,
    },
    round_of_victory: {
      lean: roundOfVictory >= 60 ? 'EARLY' : roundOfVictory >= 40 ? 'MID' : 'LATE',
      confidence: clamp(roundOfVictory),
      early: roundOfVictory,
      mid: 100 - Math.abs(roundOfVictory - 50) * 2,
      late: 100 - roundOfVictory,
    },
    round_of_finish: {
      lean: roundOfFinish >= 60 ? 'EARLY' : roundOfFinish >= 40 ? 'MID' : 'LATE',
      confidence: clamp(roundOfFinish),
      early: roundOfFinish,
      mid: 100 - Math.abs(roundOfFinish - 50) * 2,
      late: 100 - roundOfFinish,
    },
    method_of_finish: {
      method: methodOfFinish >= 60 ? (aFinish >= bFinish ? 'KO/TKO' : 'SUB') : 'DECISION',
      confidence: clamp(methodOfFinish),
      ko_tko: aFinish,
      submission: bFinish,
      decision: goesDistance,
    },
  };
}

export function scoreFight({ fighterA, fighterB, fighterAName, fighterBName, marketContext = null }) {
  const aScore = LAYER_DEFS.reduce((sum, def) => sum + (layerScore(fighterA, def.key) ?? 50) * def.weight, 0);
  const bScore = LAYER_DEFS.reduce((sum, def) => sum + (layerScore(fighterB, def.key) ?? 50) * def.weight, 0);
  const edgeScore = Math.abs(aScore - bScore);
  const favored = aScore >= bScore ? fighterAName : fighterBName;
  const posture = edgeScore >= 12 ? 'PICK' : edgeScore >= 7 ? 'EVIDENCE_LEAN' : edgeScore >= 3 ? 'LEAN' : 'NO_CLEAR_PICK';
  const shape = fightShape(fighterA, fighterB);

  return {
    fighter_a_name: fighterAName,
    fighter_b_name: fighterBName,
    fighter_a_score: Math.round(aScore),
    fighter_b_score: Math.round(bScore),
    fighter_a_posture: posture,
    fighter_b_posture: posture,
    favored,
    edge_score: Math.round(edgeScore),
    confidence: clamp(edgeScore * 5),
    posture,
    market_context: marketContext,
    fighter_a_ledger: fighterA,
    fighter_b_ledger: fighterB,
    fighter_a_layers: LAYER_DEFS.length,
    fighter_b_layers: LAYER_DEFS.length,
    fighter_a_win_path: { path: 'pressure', strength: layerScore(fighterA, 'striking_offense'), basis: 'composite offense' },
    fighter_b_win_path: { path: 'pressure', strength: layerScore(fighterB, 'striking_offense'), basis: 'composite offense' },
    fighter_a_counter_risk: { risk: 'counter', severity: layerScore(fighterA, 'durability'), basis: 'durability' },
    fighter_b_counter_risk: { risk: 'counter', severity: layerScore(fighterB, 'durability'), basis: 'durability' },
    lanes: {
      winner: shape.winner,
      method_of_victory: shape.method_of_victory,
      go_the_distance: shape.go_the_distance,
      round_of_victory: shape.round_of_victory,
      round_of_finish: shape.round_of_finish,
      method_of_finish: shape.method_of_finish,
    },
    posture_reason: edgeScore >= 3 ? 'composite edge' : 'edge too small',
  };
}

export function scoreCard(fights) {
  return {
    fights: fights.map((fight) => scoreFight(fight)),
  };
}

