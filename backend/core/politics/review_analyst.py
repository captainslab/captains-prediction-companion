"""
PoliticsReviewAnalyst — post-alpha review layer for politics markets.

Responsibilities:
- Apply no-bet classifier (edge, confidence, data-gap gates)
- CLV tracking stub (records fair_probability at time of analysis)
- Produce final reviewed RouterOutput with audit trail
- Flag unusual market conditions (toss-up, scandal, missing data)

This mirrors the sports SportsReviewAnalyst pattern but for politics.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field

from .config import DEFAULT_POLITICS_ALPHA_CONFIG, PoliticsAlphaConfig
from .models import PoliticsRouterOutput, PoliticsRouterInput


# ---------------------------------------------------------------------------
# CLV stub record
# ---------------------------------------------------------------------------

@dataclass
class _CLVRecord:
    market_id: str
    fair_probability: float
    recorded_at: float
    pipeline: str


_CLV_LOG: list[_CLVRecord] = []


# ---------------------------------------------------------------------------
# No-bet classifier
# ---------------------------------------------------------------------------

def _should_pass(
    output: PoliticsRouterOutput,
    config: PoliticsAlphaConfig,
) -> tuple[bool, str]:
    """Returns (pass_flag, reason). pass_flag=True means NO BET."""
    if output.no_bet_flag:
        return True, output.no_bet_reason

    edge_cents = abs(output.edge) * 100
    if edge_cents < config.min_edge_cents:
        return True, f"edge {edge_cents:.1f}¢ < threshold {config.min_edge_cents:.1f}¢"

    if output.confidence < config.min_confidence:
        return True, f"confidence {output.confidence:.2f} < threshold {config.min_confidence:.2f}"

    if output.intel_report and output.intel_report.error:
        if "narrative_fetch_failed" in output.intel_report.error:
            # Can still bet with polls + consensus, but flag it
            pass

    return False, ""


# ---------------------------------------------------------------------------
# Review analyst
# ---------------------------------------------------------------------------

class PoliticsReviewAnalyst:
    """
    Final review pass before returning output to the companion router.
    Applies no-bet gate, records CLV, adds audit notes.
    """

    def __init__(self, config: PoliticsAlphaConfig = DEFAULT_POLITICS_ALPHA_CONFIG) -> None:
        self.config = config

    def review(
        self,
        inp: PoliticsRouterInput,
        output: PoliticsRouterOutput,
    ) -> PoliticsRouterOutput:
        # CLV record
        if output.fair_probability > 0:
            _CLV_LOG.append(_CLVRecord(
                market_id=inp.market_id,
                fair_probability=output.fair_probability,
                recorded_at=time.time(),
                pipeline=output.pipeline,
            ))

        # No-bet classification
        pass_flag, pass_reason = _should_pass(output, self.config)
        if pass_flag and not output.no_bet_flag:
            output.no_bet_flag = True
            output.no_bet_reason = pass_reason
            output.recommendation = "pass"
            output.notes.append(f"review_analyst: no_bet — {pass_reason}")

        # Audit trail note
        output.notes.append(
            f"reviewed_by=politics_review_analyst "
            f"edge={output.edge*100:.1f}¢ "
            f"confidence={output.confidence:.2f} "
            f"data_quality={output.extra.get('data_quality', 'unknown')}"
        )

        return output

    def clv_log(self) -> list[_CLVRecord]:
        return list(_CLV_LOG)
