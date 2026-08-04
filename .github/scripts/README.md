# Project automation

Three workflows keep the Griptape org project's `Status` field honest without
relying on humans to flip it manually.

| Workflow | Trigger | What it does |
|---|---|---|
| `project-triage-new-issues.yml` | hourly (`:00`) | Find open issues across every repo in the org that aren't on the project yet, add them, and set `Status = To Triage`. |
| `project-set-in-progress.yml` | hourly (`:30`) | If `Status = Backlog` AND item is in the current iteration AND has ≥1 assignee → set `Status = In Progress`. |
| `project-iteration-rollover.yml` | daily at 06:00 UTC | If `Status = In Progress` AND the assigned iteration has ended → set `Status = Backlog`, clear `Iteration`. Also catches "orphan" items: `Status = In Progress` with no `Iteration` set (or with no assignees), untouched for 24h → `Status = Backlog`. |

Both workflows can also be triggered manually via **Actions → Run workflow**,
with a `dry_run` toggle that logs changes without applying them. Run dry-run
once after any field rename to confirm the scripts still resolve everything.

## Setup

These scripts mutate the org-level project, which the default `GITHUB_TOKEN`
can't do, so the workflows mint an installation token from a dedicated GitHub
App instead.

A PAT would also work, but it is the wrong shape for scheduled automation.
Every PAT a person holds shares one 5,000 points/hour GraphQL budget keyed to
their user ID, along with every OAuth app and CLI they have authorized. Three
sweeps paginating `ProjectV2` items at roughly 30 points a page will quietly
eat that budget and then break whatever else that human was doing. An
installation token owned by `griptape-ai` gets its own 10,000 points/hour
GraphQL budget, separate from any person.

### Register the App

There is no API that creates a GitHub App, so this step is a browser click.
This link prefills every field:

<https://github.com/organizations/griptape-ai/settings/apps/new?name=Griptape+Projects&url=https%3A%2F%2Fgithub.com%2Fgriptape-ai%2F.github&public=false&issues=read&pull_requests=read&organization_projects=write>

Confirm these are set before clicking **Create GitHub App**, since URL
prefill is best-effort and silently drops anything it does not recognize:

| Scope | Permission | Why |
|---|---|---|
| Organization | **Projects: Read and write** | Read items, write `Status`, clear `Iteration`. Must be the *organization* permission, not the repository one, which covers classic repo projects instead. |
| Repository | **Issues: Read-only** | The triage search, and issue assignee counts. |
| Repository | **Pull requests: Read-only** | PR assignee counts on project items. |

Webhooks stay off. Nothing listens for events, and the prefill link leaves
them disabled.

Then **Install App** on **All repositories**. The triage sweep searches issues
org-wide and silently skips anything the installation cannot see. Installing
is also browser-only for an org-owned App: the programmatic install endpoints
only work for enterprise-owned Apps, and require a separate bootstrap App plus
enterprise owner rights.

### Wire up the secrets

Generate a private key on the App's settings page, then from that directory:

```sh
gh variable set PROJECTS_APP_CLIENT_ID --repo griptape-ai/.github --body "Iv23li..."
gh secret set PROJECTS_APP_PRIVATE_KEY --repo griptape-ai/.github < griptape-projects.*.private-key.pem
rm griptape-projects.*.private-key.pem
```

Use the **Client ID** (`Iv23li...`), not the numeric App ID. Both work, but
`actions/create-github-app-token` treats `app-id` as legacy.

Each workflow then narrows the token further with `permission-*` inputs, so
the App can hold the superset while any single job only gets what it uses.
`actions/create-github-app-token` revokes the minted token when the job ends,
so there is nothing to rotate and nothing to babysit.

Once a dry run passes, delete the old `PROJECTS_TOKEN` secret so nothing can
quietly fall back to a human's rate limit.

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

For local runs, `PROJECTS_TOKEN` can be a fine-grained PAT with the same
permissions as the App (org Projects write, repo Issues read, repo Pull
requests read, all repositories). Keep that PAT for local use only. Pointing
the scheduled workflows at it puts the sweeps back on your personal rate
limit.

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
