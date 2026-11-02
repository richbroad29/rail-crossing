# map-service

The live train map's back end (see the brief, "UK Live Train Map brief"). A separate service from
the Portslade crossing back end on `backend-v2`: its own process, its own Network Rail connection,
its own data folder. Nothing in here is imported by, or imports from, `backend/`.

Current state: **phase 0 — prove the data.** `phase0/` holds read-only check scripts that run on
the VPS and answer the questions phase 1 depends on. See `phase0/RUNBOOK.md`.
