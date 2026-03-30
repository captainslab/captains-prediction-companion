# Claude Code Handoff Notes

- **Summary:** Claude-focused work now routes mention-based markets into `run_event_board` for the default `--market-id` flow, while `--child-market` stays as the explicit help/inspection mode. Decision outputs are generated via `DecisionLogicAgent` and ranked by `best_executable_edge`.
- **Key files:**  
  - `backend/run_market.py` (default `--market-id` routing, `--child-market` flag)  
  - `backend/core/politics/apps/mentions_app.py` (child/event runners, per-child metadata, ranking)  
  - `backend/tests/test_alpha_agent_integration.py` and `backend/tests/test_decision_logic_agent.py` (coverage for event ranking, child helper, policy behavior)
- **Notes for Claude engineers:**  
  1. Ensure Claude tooling consumes the new `ranked_summary` shape (`child_ticker`, `word`, `fair_*`, `market_*`, `best_executable_edge`, `trade_posture`, `settlement_state`, `reject_reason`).  
  2. Keep `decision_logic_agent` confidence logic in mind when tuning low-confidence thresholds (the default floor is 0.5).  
  3. If additional metadata needs to flow from Claude (e.g., settlement flags), add entries to `MentionEventInput.metadata` so `_build_decision_input` can read them.  
  4. Continue monitoring `CLAUDE.md` for broader project notes.
