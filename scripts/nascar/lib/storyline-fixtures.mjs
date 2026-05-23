// Storyline + team graph fixtures for the Coca-Cola 600 dry-run packet.
// Fixture-mode placeholders only. No live network. No credentials. No trading.
// Sources are intentionally not real URLs; replace with sourced packet before publication.
//
// Numeric fields (emotional_strength, direct_connection, track_relevance,
// team_car_relevance, broadcast_public_attention, distraction_pressure_risk)
// are flat scalars on the storyline so they feed composeStorylineModifier()
// directly. Descriptive context lives under `meta`.

export const FIXTURE_SOURCE_NOTE = 'fixture-mode placeholder; replace with sourced packet before publication';

export function cocaCola600StorylineFixture() {
  return {
    storyline_id: 'coca-cola-600-2026-kyle-busch-tribute',
    storyline_type: 'tragedy_tribute',
    headline: 'RCR runs a black No. 8 tribute scheme for Kyle Busch at the Coca-Cola 600; Austin Hill subs in.',
    summary:
      'Following the death of Kyle Busch, Richard Childress Racing announced a one-off tribute paint scheme on the No. 8 Chevrolet for the Coca-Cola 600. Austin Hill is named as the substitute driver for the tribute entry. Storyline is layered as a MODIFIER only; it does not by itself create on-track speed.',
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
        notes: 'Tribute paint scheme runs on the RCR No. 8.',
      },
      beneficiary_hint: {
        driver_name: 'Austin Hill',
        car_number: 33,
        relationship: 'former_teammate_rcr_organization',
      },
    },
    sources: [
      { label: FIXTURE_SOURCE_NOTE, url: null },
    ],
    safety_notes: [
      'Storyline fields are fixture placeholders and UNVERIFIED in source files.',
      'No fabricated URLs included.',
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
          { car_number: 8, tribute_scheme_active: true, tribute_for: 'Kyle Busch' },
          { car_number: 33, cross_series: true },
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
      { label: FIXTURE_SOURCE_NOTE, url: null },
    ],
  };
}
