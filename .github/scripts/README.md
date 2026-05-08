# Project automation

Three workflows keep the Griptape org project's `Status` field honest without
relying on humans to flip it manually.

| Workflow | Trigger | What it does |
|---|---|---|
| `project-triage-new-issues.yml` | every 15 min | Find open issues across every repo in the org that aren't on the project yet, add them, and set `Status = To Triage`. |
| `project-set-in-progress.yml` | every 15 min | If `Status = Backlog` AND item is in the current iteration AND has ≥1 assignee → set `Status = In Progress`. |
| `project-iteration-rollover.yml` | daily at 06:00 UTC | If `Status = In Progress` AND the assigned iteration has ended → set `Status = Backlog`, clear `Iteration`. Also catches "orphan" items: `Status = In Progress` with no `Iteration` set (or with no assignees), untouched for 24h → `Status = Backlog`. |

Both workflows can also be triggered manually via **Actions → Run workflow**,
with a `dry_run` toggle that logs changes without applying them. Run dry-run
once after any field rename to confirm the scripts still resolve everything.

## Setup

These scripts mutate the org-level project, which the default `GITHUB_TOKEN`
can't do. You need a token with project write access.

### Option A: fine-grained PAT (fastest)

1. https://github.com/settings/personal-access-tokens → **Generate new token**.
2. Resource owner: `griptape-ai`.
3. Repository access: **All repositories** (the triage sweep searches issues
   across every repo in the org; the other workflows only need the token to
   authenticate).
4. Repository permissions:
   - **Issues: Read-only** (so the search can see issues in every repo)
5. Organization permissions:
   - **Projects: Read and write**
   - **Members: Read-only**
6. Copy the token, add it as a repository secret in `griptape-ai/.github`
   named `PROJECTS_TOKEN`.

PATs expire. Calendar a renewal.

### Option B: GitHub App (preferred long-term)

1. Create an org-level GitHub App with `organization_projects: write`,
   `members: read`, and `issues: read`.
2. Install it on **all** org repos (the triage sweep needs to see issues
   org-wide).
3. Use a token-minting action (`tibdex/github-app-token` or
   `actions/create-github-app-token`) at the start of each job and pass the
   minted token as `PROJECTS_TOKEN`.

No expirations to babysit; recommended once the workflows prove out.

## Local development

```sh
cd .github/scripts
npm install
PROJECTS_TOKEN=ghp_xxx PROJECT_OWNER=griptape-ai PROJECT_NUMBER=2 DRY_RUN=true \
  node triage-new-issues.mjs
PROJECTS_TOKEN=ghp_xxx PROJECT_OWNER=griptape-ai PROJECT_NUMBER=2 DRY_RUN=true \
  node set-in-progress.mjs
PROJECTS_TOKEN=ghp_xxx PROJECT_OWNER=griptape-ai PROJECT_NUMBER=2 DRY_RUN=true \
  node iteration-rollover.mjs
```

`DRY_RUN=true` logs every flip without making any GraphQL mutations. Use this
to confirm behaviour before letting the cron loose.

## Field assumptions

The scripts resolve field IDs by name on every run, so renaming a field
breaks them loudly (with a clear error) rather than silently misbehaving.
Required fields:

- `Status` (single-select) with options `To Triage`, `Backlog`, `In Progress`, `In Review`, `Done`
- `Iteration` (iteration field)

If any of those names change, update the strings in `project-helpers.mjs`.

## What these workflows deliberately do not do

- They never move items into `In Review`, `Done`, or `Blocked`. The first two
  are handled by built-in project workflows (PR opened → In Review, issue
  closed → Done); `Blocked` is intentionally manual because it requires
  context only a human has.
- They never demote `In Progress` back to `Backlog` while the iteration is
  still active and the item has an assignee. Mid-iteration churn should be a
  deliberate human decision. The orphan sweep is the one exception: if
  `In Progress` is set with no iteration at all, or with no assignees, and
  nothing touches the item for 24h, it gets returned to Backlog on the
  assumption that the iteration was forgotten or the work was abandoned.
- They never archive items. Auto-archive is a built-in project workflow;
  configure it on the project itself.
