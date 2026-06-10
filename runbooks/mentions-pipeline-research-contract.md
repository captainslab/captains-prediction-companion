# Mentions Pipeline Research Contract

**Version:** 2026-06-10  
**Scope:** Mentions-only. MLB, UFC, NASCAR, and all other pipelines are explicitly out of scope.  
**Status:** Active — post-repair operational baseline.

---

## 1. File Contracts

### 1.1 Research Drop Point
```
state/mentions/<DATE>/research/*.json
```
- One JSON file per mention event under research.
- Written by the **Codex (Alpha Hunter)** canonical role.
- Consumed by the generator during synthesis/scoring.

### 1.2 Event Fallback Drop Point
```
state/mentions/<DATE>/kalshi-events/*.json
```
- Written by `generate-mentions-daily.mjs` during discovery.
- Raw Kalshi API event responses, normalized but un-scored.
- Used as fallback when research JSON is absent.

### 1.3 Output Drop Point
```
state/packets/<DATE>/mentions-daily/
```
- `.txt` packet files (sectioned decision board).
- `.meta.json` sidecars with generation metadata.
- `.inventory.txt` audit artifacts (raw contract inventory, never the packet body).

---

## 2. Canonical Hermes Routing Table (Single Source of Truth)

| Canonical Role | Equivalent Names | Responsibilities |
|---|---|---|
| **Codex** | Alpha Hunter, alpha-hunter, alpha_hunter | Research collection, source discovery, evidence gathering, research JSON creation |
| **Kimi** | Market Hunter, market-hunter, market_hunter | Synthesis, scoring interpretation, packet narrative generation, subscriber article drafting |

### 2.1 Routing Rules
1. **Codex** and **Alpha Hunter** are the same canonical role and must be treated identically.
2. **Kimi** and **Market Hunter** are the same canonical role and must be treated identically.
3. Any non-canonical model name, alias, provider-specific model identifier, or legacy routing label must be mapped to either **Codex (Alpha Hunter)** or **Kimi (Market Hunter)** before execution.
4. No task may execute under an unmapped alias.
5. All routing documentation, configuration, verification output, and execution logs must reference this canonical routing table rather than redefining mappings elsewhere.

### 2.2 Alias-to-Canonical-Role Mapping

The following aliases resolve as shown:

| Alias | Canonical Role |
|---|---|
| `codex` | Codex (Alpha Hunter) |
| `alpha-hunter` | Codex (Alpha Hunter) |
| `alpha_hunter` | Codex (Alpha Hunter) |
| `kimi` | Kimi (Market Hunter) |
| `market-hunter` | Kimi (Market Hunter) |
| `market_hunter` | Kimi (Market Hunter) |

Any alias not listed above must be explicitly mapped before use.

---

## 3. Durable Mentions Loop

```
1. DISCOVER
   └─> generate-mentions-daily.mjs discovers today's Mentions events
       (broad + series-scan, merged + deduped)

2. COLLECT (Codex / Alpha Hunter)
   └─> Research collection runs via Hermes external command
       └─> Writes research JSON into state/mentions/<DATE>/research/

3. GENERATE
   └─> Rerun generator to score contracts using research JSON + kalshi-events
       └─> Produces packet .txt + .meta.json artifacts

4. SYNTHESIZE (Kimi / Market Hunter)
   └─> Packet narrative generation / subscriber article drafting
       └─> Reads scored packets, produces polished subscriber article .txt

5. VERIFY
   └─> Artifact verification and safety scan
```

---

## 4. Pipeline Command

```bash
cd /home/jordan/captains-prediction-companion
node scripts/packets/generate-mentions-daily.mjs --date YYYY-MM-DD --window-days 0 --dry-run
```

- `--window-days 0` restricts to the exact date.
- `--dry-run` prevents side effects (safe for verification).
- Remove `--dry-run` for production artifact writes.

---

## 5. Format Requirements

### 5.1 Packet Body
- Must use the **Substack-style house format** (sectioned decision board).
- Must NOT contain raw diagnostic boards or YAML walls.

### 5.2 Contract Labels
- Render from `custom_strike` / `display` fields.
- Must NOT render from ticker suffixes.

### 5.3 Scoring
- **Market price is excluded from composite scoring.**
- Composite score is source-layer conviction (0-100), NOT a probability.
- Market context is displayed for edge detection only.

### 5.4 BLOCKED Rows
- `BLOCKED` means **missing research**, not pipeline failure.
- Trigger text must specify the exact research gap and next step.

---

## 6. Scope Lock

| In Scope | Out of Scope |
|---|---|
| Mentions events for the requested date | MLB, UFC, NASCAR |
| Research JSON production | Stripe, Discord, Telegram sending |
| Packet generation and scoring | Website, billing, trading |
| Subscriber article formatting | Trade execution, bankroll automation |
| Hermes routing documentation | Any modification to non-Mentions pipelines |

**Hard rule:** Preserve existing MLB, UFC, and NASCAR workflows exactly as they are today. Do not modify their routing, scoring, packet generation, research process, model assignments, automation, outputs, or operational behavior.

---

## 7. Safety Requirements

- No secrets printed in logs or artifacts.
- No raw inventory in packet body (routed to `.inventory.txt` audit artifact).
- No trade execution language.
- No bankroll advice or order placement.
- No screenshot/UI references in subscriber articles.

---

## 8. Verification Checklist

Before marking the pipeline operational:

- [ ] Hermes command/config documented, without secrets.
- [ ] Canonical Hermes Routing Table referenced in execution.
- [ ] Complete alias-to-canonical-role mapping documented.
- [ ] Codex (Alpha Hunter) route status confirmed (live / missing).
- [ ] Kimi (Market Hunter) route status confirmed (live / missing).
- [ ] Every configured model alias resolves to a canonical role before execution.
- [ ] MLB, UFC, NASCAR workflows confirmed untouched.
- [ ] Commands run and artifact paths recorded.
- [ ] Packet counts by PICK / LEAN / WATCH / FADE / BLOCKED / PASS recorded.
- [ ] First 80 lines of final subscriber article `.txt` reviewed.
- [ ] Safety scan passed (no secrets, raw inventory in body, trade execution, bankroll language, screenshot/UI references).

---

## 9. Stop Conditions

Stop and report (do not proceed) if:

- Hermes routing cannot be verified.
- Required source collection cannot be performed.
- Secrets are encountered in logs, configs, or artifacts.
- Packet verification fails (wrong format, scoring bug, missing metadata).
- Any requested change would affect MLB, UFC, or NASCAR behavior.
- A non-canonical alias is used without explicit mapping.

---

## 10. Rerun Command

```bash
cd /home/jordan/captains-prediction-companion
node scripts/packets/generate-mentions-daily.mjs --date $(date +%Y-%m-%d) --window-days 0
```

For a specific date:
```bash
node scripts/packets/generate-mentions-daily.mjs --date 2026-06-10 --window-days 0
```

---

*Generated 2026-06-10. Mentions-only. All other pipelines preserved.*
