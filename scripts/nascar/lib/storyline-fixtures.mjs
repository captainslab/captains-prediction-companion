// Storyline + team graph snapshot for the Coca-Cola 600 packet.
// Public-source context only. No credentials. No trading.
//
// Numeric fields (emotional_strength, direct_connection, track_relevance,
// team_car_relevance, broadcast_public_attention, distraction_pressure_risk)
// are flat scalars on the storyline so they feed composeStorylineModifier()
// directly. Descriptive context lives under `meta`.

export const FIXTURE_SOURCE_NOTE = 'public-source storyline context; non-scoring only';
const AP_RCR_NO33_URL = 'https://apnews.com/article/200880317c943523957143ac8f035af9';
const NASCAR_TRIBUTE_URL = 'https://www.nascar.com/news-media/2026/05/23/cup-series-2026-kyle-busch-in-tribute/';

export function cocaCola600StorylineFixture() {
  return {
    storyline_id: 'coca-cola-600-2026-kyle-busch-tribute',
    storyline_type: 'tragedy_tribute',
    headline: 'RCR suspends No. 8 use after Kyle Busch death; Austin Hill runs No. 33 at the Coca-Cola 600.',
    summary:
      'Following the death of Kyle Busch after hospitalization, public reports say Richard Childress Racing suspended use of No. 8, will run No. 33, and scheduled Austin Hill for Charlotte. Storyline is layered as a non-scoring modifier only; it does not by itself create on-track speed.',
    // Flat numeric inputs consumed by composeStorylineModifier:
    emotional_strength: 95,
    direct_connection: 90,
    timing_proximity_days: 6,
    track_relevance: 80,
    team_car_relevance: 95,
    broadcast_public_attention: 90,
    distraction_pressure_risk: 55,
    meta: {
      track_relevance_context: {
        track: 'Charlotte Motor Speedway',
        notes: 'Charlotte is a home-region track for the RCR organization; symbolic weight is elevated.',
      },
      team_car_relevance_context: {
        team: 'Richard Childress Racing',
        car_number: 8,
        manufacturer: 'Chevrolet',
        notes: 'RCR suspended use of No. 8 and shifted the active context to No. 33.',
      },
      beneficiary_hint: {
        driver_name: 'Austin Hill',
        car_number: 33,
        relationship: 'former_teammate_rcr_organization',
      },
    },
    sources: [
      { label: 'AP/RCR No. 33 report', url: AP_RCR_NO33_URL },
      { label: 'NASCAR Kyle Busch tribute analysis', url: NASCAR_TRIBUTE_URL },
    ],
    safety_notes: [
      'Storyline context is source-backed but non-scoring.',
      'Storyline is a modifier only; it does not create speed.',
    ],
  };
}

// Shape matches what storyline-modifier.detectBeneficiary() reads:
//   g.honoree { name, team, car_number, manufacturer }
//   g.former_teammates  (lowercased name match)
//   g.family_link, g.replacement_for (optional)
// Extra fields below (teams, manufacturer_circles, relationships) are documentary.
export function teamGraphFixture() {
  return {
    schema_version: 'nascar_team_graph_v1_fixture',
    honoree: {
      name: 'Kyle Busch',
      team: 'RCR',
      car_number: 8,
      manufacturer: 'Chevrolet',
    },
    replacement_for: 'Kyle Busch',
    former_teammates: ['Austin Hill', 'Austin Dillon'],
    teams: {
      RCR: {
        team_id: 'RCR',
        team_name: 'Richard Childress Racing',
        manufacturer: 'Chevrolet',
        roster: [
          { driver_name: 'Austin Dillon', car_number: 3, primary: true },
          { driver_name: 'Kyle Busch', car_number: 8, primary: true, status: 'deceased_recent' },
          { driver_name: 'Austin Hill', car_number: 33, primary: false, role: 'xfinity_full_time_cup_substitute' },
        ],
        cars: [
          { car_number: 3 },
          { car_number: 8, use_suspended: true, reserved_context_for: 'Kyle Busch' },
          { car_number: 33, active_context_after_no8_suspension: true, cross_series: true },
        ],
      },
    },
    manufacturer_circles: {
      Chevrolet: ['RCR', 'Hendrick Motorsports', 'Trackhouse Racing', 'Spire Motorsports'],
    },
    relationships: [
      {
        from_driver: 'Austin Hill',
        to_driver: 'Kyle Busch',
        relationship: 'former_teammate_rcr_organization',
        flag: 'former_teammate',
      },
      {
        from_driver: 'Austin Dillon',
        to_driver: 'Kyle Busch',
        relationship: 'teammate_rcr',
        flag: 'teammate',
      },
    ],
    sources: [
      { label: 'AP/RCR No. 33 report', url: AP_RCR_NO33_URL },
      { label: 'NASCAR Kyle Busch tribute analysis', url: NASCAR_TRIBUTE_URL },
    ],
  };
}
