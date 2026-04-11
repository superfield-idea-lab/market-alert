# Phase 7 — BDM View Service Flow

## Overview

This document describes the service flow for the Business Development Manager
(BDM) view shipped in Phase 7. The BDM view gives sales and BD team members
a consolidated view of prospect activity, knowledge asset usage, and deal
pipeline context derived from knowledge base interactions.

## State machine

```
[Authenticated as BDM] ──navigate──> [BDM Dashboard]
        │
        ├── [Deal Pipeline Panel]
        │       │
        │       ├── select deal ──> [Deal Detail]
        │       │       │
        │       │       ├── view timeline ──> [Activity Timeline]
        │       │       ├── view assets ──> [Linked Assets]
        │       │       └── create note ──> [Note Input] ──> [Deal Detail]
        │       │
        │       └── create deal ──> [New Deal Form] ──> [Deal Detail]
        │
        ├── [Knowledge Asset Panel]
        │       │
        │       ├── search assets ──> [Asset Search Results]
        │       └── select asset ──> [Asset Detail] ──> [Link to Deal]
        │
        └── [Activity Feed]
                │
                └── select event ──> [Event Detail]
                        │
                        └── link to deal ──> [Deal Selector] ──> [Deal Detail]
```

## Actors

| Actor         | Role                                               |
| ------------- | -------------------------------------------------- |
| BDM           | Full access to dashboard, deals, and asset linking |
| Sales Manager | Read-only view of team BDM dashboards              |
| Admin         | Full CRUD on deals and assignments                 |

## Entry points

- `/bdm` — BDM dashboard home
- `/bdm/deals/:id` — specific deal detail
- `/bdm/assets` — knowledge asset browser for BDMs

## Key interactions

### Deal pipeline

1. Dashboard loads `GET /api/bdm/deals` with pagination and filters.
2. Deals rendered as kanban columns (stage-based) or list view.
3. Stage transitions via drag-and-drop or status dropdown.
4. `PATCH /api/bdm/deals/:id { stage }` persists changes.

### Knowledge asset linking

1. BDM selects a knowledge article or recording from asset panel.
2. "Link to Deal" action opens deal selector modal.
3. `POST /api/bdm/deals/:id/assets { assetId, assetType }` creates link.
4. Linked asset appears in deal's `[Linked Assets]` tab.

### Activity timeline

1. Timeline fetches `GET /api/bdm/deals/:id/activity`.
2. Events sorted by timestamp descending.
3. Each event shows actor, action, and linked resource.

## Error states

| State           | Trigger                                | Recovery                                              |
| --------------- | -------------------------------------- | ----------------------------------------------------- |
| Unauthorised    | Non-BDM accesses `/bdm`                | Redirect to home with "Access denied" toast           |
| Stale deal data | Another BDM updates stage concurrently | Show "Updated by [name]" banner; refresh data         |
| Asset not found | Linked asset deleted                   | Show "Asset unavailable" placeholder in Linked Assets |
