# Installed Office HTTP failure replay

Source: local candidate a1b8a033, turn 8120b3e2-8852-40d7-9e0f-77ac5d1bacb3, 2026-11-21.
`field-deck.json` is the captured last non-blocked PPT input, not a corrected hand-authored deck.
`sales.csv` SHA-256: a51c92e2b2f3195852144317f90d84ffeb9f51b7232b80c1576e998dcc2096f5.

Replay preserves all deck fields, final:true, no draft and standard layout. Only the destination is isolated and
the stale transformation_ref is replaced with a real current computation. The original transform input was not
captured in the final evidence, so the test explicitly uses a replacement select/group/aggregate plan producing
Region/TotalSales. This is a deterministic reproduction of the failed write input, not a paid model run.
