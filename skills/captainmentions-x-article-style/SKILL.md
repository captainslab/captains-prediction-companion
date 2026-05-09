---
name: captainmentions-x-article-style
description: Use when drafting CaptainMentions X Articles from completed mention-market research; preserves the account’s observed Section A-G style, trade-first wording, exact-word proof framing, code-box tables, coffee CTA, and signoff.
version: 1.0.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [captainmentions, x-article, article-format, mentions, trading, style]
    related_skills: [captain-x-article-guide, captain-mentions-research-system, captain-mixmcp-calibration]
---

# CaptainMentions X Article Style

## Purpose

Use this skill after the research and trade-gate work is complete and the user wants an X Article draft in the CaptainMentions style.

Observed source used to build this style:
- https://x.com/CaptainMentions
- https://x.com/CaptainMentions/status/2050307728959054097
- Firecrawl output saved under `.firecrawl/captainmentions-style/`
- Parsed article markdown: `.firecrawl/captainmentions-style/post-2050307728959054097.article.md`

The account voice is evidence-first, trade-first, settlement-safe, and exact-word focused. It writes like a market guide, not a generic blog post.

## Hard gates

Do not draft the public article until the internal packet contains:
- exact market/event link
- contract/rule mechanics
- eligible speaker/event window
- current YES/NO prices or user-provided price snapshot
- TV, LSP, edge, max entry
- trade gate for each strike
- best YES / best NO candidates
- live playbook
- correlation groups/stacks
- sneaky NOs
- quick counts / doesn’t-count checklist
- how-it-loses language for every pick

If any of these are missing, write a short “needs research/pricing” note instead of inventing content.

## Observed article skeleton

Use this structure by default:

```text
[Title]

SECTION A — What to expect. Environment and situation
Event: ...
Reality: ...
Record: ...
Settlement: ...
Tree-in-the-Forest Problem: ...

SECTION B — Board
[plain text table]
TV = Calculated True Value.
LSP = limit sell target after fill. For YES, LSP is TV. For NO, LSP is 100 − TV.
Edge = expected move to LSP on picked side.
Max Entry = highest acceptable entry to preserve the trade thesis.
Captain read: ...

SECTION C — Best Picks
Best YES
1 → [Strike] YES
- ...
Entry:
No chase:
Cashout:
How it loses:

Best NOs
1 → [Strike] NO
- ...
Entry:
Current NO:
LSP:
How it loses:

SECTION D — Live Playbook
Live Trade 1 — YES/NO: [Strike]
Entry zone:
Ceiling:
Cashout target:
Buy signals:
- ...
De-risk signals:
- ...
LSP:

SECTION E — Groups / Correlation Stacks
Group 1 — [Name]
Logic: ...
[plain text table]
How it loses:
- ...

SECTION F — Sneaky NOs
- [Strike] — [why exact-word/topic risk makes NO live]

SECTION G — Quick checklist
Counts
- ...
Doesn’t count
- ...

Captain’s bottom line:
...

Fuel the next premium guide? Buy Captain a coffee ☕
https://buymeacoffee.com/captainmentions

🫡🇺🇸💰
```

## Voice rules

Write like this:
- “This is still a proof market.”
- “The resolving issue is not whether the topic is relevant.”
- “The resolving issue is whether [speaker] says the exact word or phrase during the qualifying [event] and it is documentable.”
- “Tree-in-the-Forest Problem: If [topic] happens but the exact resolving word never gets said, the market still pays NO.”
- “The play is entry-sensitive.”
- “This is not a fat-edge misprice at [price].”
- “Cleaner value fade.”
- “Best raw board edge.”
- “Live, but not structurally required.”
- “The board has shifted.”
- “First place to hunt for repricing.”

Avoid:
- second-person ownership language like “your shares” or “you should buy”
- guarantees
- source dumps inside public body
- academic phrasing
- long methodology explanations
- saying a topic will resolve if the exact word path is weak

## Table style

Use plain-text code-box markdown tables for large boards:

```plaintext
| Keyword | YES¢ | NO¢ | TV | LSP | Edge | Max Entry | Pick | Justification |
|---------|-----:|----:|---:|----:|-----:|----------:|------|---------------|
```

For groups, shorter tables are acceptable:

```plaintext
| Keyword | YES¢ | NO¢ | Side | LSP | Edge | Justification |
|---------|-----:|----:|------|----:|-----:|---------------|
```

Column definitions:
- TV = Calculated True Value.
- LSP = limit sell target after fill.
- For YES, LSP is TV.
- For NO, LSP is 100 − TV.
- Edge = expected move to LSP on picked side.
- Max Entry = highest acceptable entry to preserve trade thesis.

## Section A pattern

Section A should quickly set the trade environment:
- Event: exact event name, platform, speaker, event window
- Reality: split board into 2-4 lanes/clusters
- Record: strongest historical transcript/count evidence
- Settlement: exact-word proof framing
- Tree-in-the-Forest Problem: topic can occur while market still resolves NO

Keep it direct. No source list in the public body.

## Section B pattern

Section B does four things:
1. shows the board table
2. defines TV/LSP/Edge/Max Entry
3. states the Captain read in one paragraph
4. identifies where raw edge sits now

The Captain read should compare the best hit-rate YES against the best value NO/fade stack when applicable.

## Section C pattern

Use “Best YES” and “Best NOs” subheads when both sides have possible plays.

Each pick gets:
- ranked number using arrow: `1 → Strike Side`
- 2-4 bullet reasons
- Entry
- No chase / Current NO / LSP / Cashout as applicable
- How it loses

If a pick has only small edge, say it is entry-sensitive or not a fat-edge misprice.

## Section D pattern

Live playbook should be tactical:
- Entry zone
- Ceiling
- Cashout target
- Buy signals
- De-risk signals
- LSP

Buy signals should be observable early in the event: title, thumbnail, intro, first 5-10 minutes, topic lane, prompt path.

De-risk signals should tell when the thesis is dying: wrong opening lane, substitute wording, segment passes, eligible speaker dodges exact word.

## Section E pattern

Groups/correlation stacks control exposure.

Each group needs:
- name
- logic paragraph
- table or strike list
- how it loses bullets

Group names should be descriptive:
- Lawsuit YES Anchor
- Foreign-Policy NO Stack
- AI/Data Center Stack
- Border Stack
- Injury Stack
- Venue Stack

## Section F pattern

Sneaky NOs are concise bullets. Use them for:
- overpriced live-but-rich words
- exact-word traps
- topic words that can be dodged by synonyms
- words requiring a specific lane that is not structurally required
- high-probability YES markets where proof/entry risk is bad

Pattern:
```text
- [Strike] — [live/rich/trap framing]. [Why the exact word can fail].
```

## Section G pattern

Split into Counts / Doesn’t count.

Counts examples:
- exact spoken word during qualifying event
- minimum-count threshold if applicable
- plural/possessive/hyphen/open-compound if rules allow

Doesn’t count examples:
- general topic relevance without exact word
- similar words or synonyms
- non-eligible speaker
- title/description alone if spoken-word proof is required
- auto-caption spelling alone if audio proof does not support the word

## Bottom line and CTA

End with:

```text
Captain’s bottom line:
[1 concise paragraph. Name the best anchor, best value stack, and live trigger.]

Fuel the next premium guide? Buy Captain a coffee ☕
https://buymeacoffee.com/captainmentions

🫡🇺🇸💰
```

Do not omit the signoff unless the user asks for an internal-only draft.

## Verification checklist

Before returning the article:
- [ ] no source URLs in the public article body except the coffee CTA
- [ ] all big tables are in plaintext code boxes
- [ ] every pick has entry and how-it-loses language
- [ ] no unsupported picks were created by the writer
- [ ] exact-word settlement framing appears in Section A or G
- [ ] bottom line names the best anchor/value stack and trigger
- [ ] coffee CTA and 🫡🇺🇸💰 signoff are present
