'use strict';

// Real station pairs with published rail distances, for the route-accuracy regression test
// (test/track.test.js) and for track/make-route-fixture.js, which cuts the corridors out of a pack.
//
// Source for every distance: the Engineer's Line Reference (ELR) mileage tables at railwaycodes.org.uk,
// https://www.railwaycodes.org.uk/elrs/_mileages/<letter>/<elr>.shtm, which print miles.chains
// (80 chains to the mile). A pair on one ELR is the difference of its two mileages; a pair that
// crosses ELRs is the sum of the legs through the junction mileage both tables print. The ELR and the
// two mileages are on each row. mi(miles, chains) -> kilometres.
//
// Mileages are for the station building / datum; the pack's stop point is the middle of the platform
// track, so short pairs differ by up to a platform length. The test allows 10% or 250 m, whichever is larger.

const mi = (m, ch = 0) => (m + ch / 80) * 1.609344;

const PAIRS = [
  // Brighton / West Coastway (BLI1: Brighton 0.00, Hove [2] 1.35, Portslade [2] 2.73, Shoreham 5.69)
  { a: 'Brighton', b: 'Hove', km: mi(1, 35), src: 'BLI1: Hove 1m35ch from Brighton 0m00ch' },
  { a: 'Hove', b: 'Portslade', km: mi(2, 73) - mi(1, 35), src: 'BLI1: Portslade 2m73ch - Hove 1m35ch' },
  { a: 'Brighton', b: 'Shoreham-by-Sea (Sussex)', km: mi(5, 69), src: 'BLI1: Shoreham-by-Sea 5m69ch' },
  // Brighton Main Line (VTB1-3, datum London Victoria; Clayton Tunnel lies between Hassocks and Preston Park)
  { a: 'Haywards Heath', b: 'Brighton', km: mi(50, 49) - mi(37, 59), src: 'VTB3: Brighton 50m49ch - Haywards Heath 37m59ch (through Clayton Tunnel)' },
  { a: 'Hassocks', b: 'Preston Park', km: mi(49, 21) - mi(43, 42), src: 'VTB3: Preston Park 49m21ch - Hassocks 43m42ch (through Clayton Tunnel)' },
  { a: 'Haywards Heath', b: 'Hassocks', km: mi(43, 42) - mi(37, 59), src: 'VTB3: 43m42ch - 37m59ch' },
  { a: 'Three Bridges', b: 'Haywards Heath', km: mi(37, 59) - mi(29, 21), src: 'VTB3: 37m59ch - 29m21ch' },
  { a: 'Clapham Junction', b: 'London Victoria', km: mi(2, 57), src: 'VTB1: Clapham Junction 2m57ch from Victoria 0m00ch' },
  { a: 'Balham', b: 'Clapham Junction', km: mi(4, 52) - mi(2, 57), src: 'VTB1: Balham 4m52ch - Clapham Junction 2m57ch' },
  { a: 'Clapham Junction', b: 'East Croydon', km: mi(10, 28) - mi(2, 57), src: 'VTB1+VTB2: East Croydon 10m28ch - Clapham Junction 2m57ch' },
  { a: 'London Victoria', b: 'East Croydon', km: mi(10, 28), src: 'VTB1+VTB2: East Croydon 10m28ch from Victoria' },
  { a: 'Clapham Junction', b: 'London Waterloo', km: mi(3, 74) - mi(0, 5), src: 'BML1 (datum Waterloo): Clapham Junction 3m74ch - Waterloo 0m05ch' },
  // South London: London Bridge via Norwood Junction (LBW, datum London Bridge; Windmill Bridge Jn 9m69ch = VTB2 9m69ch)
  { a: 'London Bridge', b: 'East Croydon', km: mi(10, 28), src: 'LBW: Windmill Bridge Junction 9m69ch from London Bridge, then VTB2 East Croydon 10m28ch - 9m69ch' },
  // Brighton - Lewes - Eastbourne (BTL, KJE1, KJE2, KJE3)
  { a: 'Brighton', b: 'Lewes', km: mi(7, 77), src: 'BTL: Lewes 7m77ch from Brighton 0m00ch' },
  { a: 'Lewes', b: 'Eastbourne', km: mi(51, 11) - mi(49, 74) + mi(23, 73) - mi(9, 11), src: 'KJE1 Lewes 49m74ch, KJE2 to Southerham Junction 51m11ch (= KJE3 9m11ch), KJE3 Eastbourne 23m73ch' },
  // West Sussex (TBH1)
  { a: 'Three Bridges', b: 'Horsham', km: mi(37, 57) - mi(29, 21), src: 'TBH1: Horsham 37m57ch - Three Bridges 29m21ch (VTB3 datum)' },
  { a: 'Horsham', b: 'Pulborough', km: mi(50, 0) - mi(37, 57), src: 'TBH1: Pulborough 50m00ch - Horsham 37m57ch (Arun Valley line)' },
  { a: 'Pulborough', b: 'Arundel', km: mi(58, 28) - mi(50, 0), src: 'TBH1: Arundel 58m28ch - Pulborough 50m00ch (Arun Valley line)' },
  // Marshlink (ATH)
  { a: 'Rye', b: 'Appledore (Kent)', km: mi(71, 36) - mi(64, 50), src: 'ATH: Rye 71m36ch - Appledore 64m50ch' },
  { a: 'Winchelsea', b: 'Rye', km: mi(73, 22) - mi(71, 36), src: 'ATH: Winchelsea 73m22ch - Rye 71m36ch' },
  { a: 'Ashford International', b: 'Hastings', km: mi(82, 34) - mi(56, 16), src: 'ATH: Hastings 82m34ch - start of ELR at Ashford 56m16ch' },
  // Great Western main line (MLN1)
  { a: 'Reading', b: 'London Paddington', km: mi(35, 78), src: 'MLN1: Reading 35m78ch from Paddington 0m00ch' },
  // Glasgow (GOU1: Paisley Gilmour Street 6m46ch, datum Glasgow Central)
  { a: 'Glasgow Central', b: 'Paisley Gilmour Street', km: mi(6, 46), src: 'GOU1: Paisley Gilmour Street 6m46ch' },
  // Thameslink core, in tunnel (MCL St Pancras low level 2m11ch to Farringdon Jn 0m58ch; FTL Farringdon Jn 0m00ch to HHH junction 0m39ch; HHH Blackfriars 0m30ch, junction 0m21ch)
  { a: 'London St Pancras International', b: 'London Blackfriars', km: mi(2, 11) - mi(0, 58) + mi(0, 39) + mi(0, 9), src: 'MCL 2m11ch - 0m58ch, FTL 0m39ch, HHH 0m30ch - 0m21ch' }
];

module.exports = { PAIRS, mi };
