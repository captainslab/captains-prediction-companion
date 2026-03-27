from core.event_markets import (
    EventMarketContext,
    build_event_market_output_spec,
    build_event_market_pipeline,
    build_event_market_plan_payload,
    build_event_market_user_facing_output,
    build_event_market_workflow_spec,
    build_market_source_order,
    canonicalize_market_venue,
    normalize_event_domain,
)


def test_event_market_source_order_defaults_to_kalshi_then_research_then_scraper():
    assert build_market_source_order("Kalshi") == (
        "Kalshi",
        "Perplexity",
        "Playwright Scraper Skill",
    )
    assert build_market_source_order("  polymarket  ") == (
        "Polymarket",
        "Perplexity",
        "Playwright Scraper Skill",
    )


def test_event_market_name_normalization_is_cheap_and_generic():
    assert canonicalize_market_venue("KALSHI EXCHANGE") == "Kalshi"
    assert normalize_event_domain("MENTIONS") == "mention"
    assert normalize_event_domain("ECONOMICS") == "macro"


def test_event_market_pipeline_keeps_the_process_simple():
    plan = build_event_market_pipeline(
        EventMarketContext(
            venue="Kalshi",
            market_id="KXTEST123",
            title="Will the event resolve YES?",
            question="Will the event resolve YES?",
            domain="politics",
            market_type="binary",
            market_subtype="general_event",
            url="https://example.com/market",
            metadata={"notes": "keep it cheap", "source_hint": "official"},
        )
    )

    assert plan.venue == "Kalshi"
    assert plan.domain == "politics"
    assert plan.source_order == (
        "Kalshi",
        "Perplexity",
        "Playwright Scraper Skill",
    )
    assert [step.stage for step in plan.steps] == [
        "market",
        "research",
        "evidence",
        "decision",
    ]
    assert plan.primary_source == "Kalshi"
    assert plan.research_source == "Perplexity"
    assert plan.evidence_source == "Playwright Scraper Skill"
    assert "Market first" in plan.decision_rule
    assert plan.metadata["context"]["source_hint"] == "official"


def test_event_market_workflow_and_output_contract_are_explicit():
    context = EventMarketContext(
        venue="Kalshi",
        domain="sports",
        market_id="KXSPORTS42",
        title="Will the home team win?",
        question="Will the home team win?",
        market_type="binary",
        market_subtype="sports_moneyline",
        metadata={"notes": "Use the cheapest usable truth source."},
    )
    plan = build_event_market_pipeline(context)
    workflow = build_event_market_workflow_spec(context, plan)
    output_contract = build_event_market_output_spec()

    assert workflow.name == "event-market-research"
    assert [stage.stage for stage in workflow.stages] == [
        "intake",
        "market",
        "research",
        "evidence",
        "pricing",
        "decision",
        "logging",
    ]
    assert output_contract.name == "event-market-output"
    first_section = output_contract.sections[0][1]
    assert first_section[0].name == "platform"
    assert output_contract.sections[1][1][0].name == "event_domain"
    assert output_contract.sections[2][1][1].name == "recommendation"


def test_event_market_user_facing_output_defaults_to_a_safe_pricing_card():
    output = build_event_market_user_facing_output(
        EventMarketContext(
            venue="Kalshi",
            domain="sports",
            market_id="KXDUKEUNC42",
            title="Duke vs UNC college basketball winner market",
            question="Will Duke win?",
            market_type="binary",
            market_subtype="ncaamb_moneyline",
            url="https://kalshi.com/markets/example",
            metadata={
                "home_team": "Duke",
                "away_team": "North Carolina",
                "tipoff": "2026-03-27T20:00:00-04:00",
            },
        )
    ).to_dict()

    assert output["source"]["platform"] == "Kalshi"
    assert output["event_domain"] == "sports"
    assert output["event_type"] == "ncaamb_game"
    assert output["market_type"] == "moneyline"
    assert output["status"] == "needs_pricing"
    assert output["confidence"] == "medium"
    assert output["summary"]["recommendation"] == "watch"
    assert output["next_action"] == "fetch_live_prices"
    assert output["context"]["teams"]["home"] == "Duke"
    assert output["market_view"]["moneyline"]["lean"] == "watch"
    assert "workflow" not in output
    assert "source_order" not in output["summary"]["one_line_reason"].lower()


def test_event_market_plan_payload_splits_visible_and_hidden_payloads():
    response = build_event_market_plan_payload(
        EventMarketContext(
            venue="Kalshi",
            domain="earnings",
            market_id="HIMS-GLP1-MENTION",
            title='Will management say "GLP-1" on the earnings call?',
            question='Will management say "GLP-1" on the earnings call?',
            market_type="binary",
            market_subtype="earnings_call_mention",
            url="https://kalshi.com/markets/example",
            metadata={
                "company": "Hims & Hers",
                "event_name": "Q1 2026 Earnings Call",
                "start_time": "2026-05-06T17:00:00-04:00",
                "quarter": "Q1 2026",
            },
        )
    )

    assert "user_facing" in response
    assert "hidden" in response
    assert response["user_facing"]["event_type"] == "earnings_call"
    assert response["user_facing"]["market_type"] == "mention"
    assert response["user_facing"]["summary"]["recommendation"] == "watch"
    assert response["user_facing"]["market_view"]["target_phrase"] == "GLP-1"
    assert response["hidden"]["workflow"]["name"] == "event-market-research"
    assert response["hidden"]["plan"]["primary_source"] == "Kalshi"
    assert response["hidden"]["output_contract"]["sections"][0]["section"] == "source"
    assert "workflow" not in response["user_facing"]
