# Project automation

Two workflows keep the Griptape org project's `Status` field honest without
relying on humans to flip it manually.

| Workflow | Trigger | What it does |
|---|---|---|
| `project-triage-new-issues.yml` | hourly (`:00`) | Find open issues across every repo in the org that aren't on the project yet, add them, and set `Status = To Triage`. |
| `project-stale-in-progress.yml` | daily at 06:00 UTC | If `Status = In Progress` and the Status value hasn't changed in 14 days → set `Status = Backlog` and comment on the item explaining why. |

Both can be triggered manually via **Actions → Run workflow**, with a `dry_run`
toggle that logs changes without applying them. Run dry-run once after any field
rename to confirm the scripts still resolve everything.

## Status and Iteration are independent

`Status` and `Iteration` describe different axes and neither is computed from the
other.

- **`Status`** is where an item sits in the workflow. Humans move it. Automation
  writes it in exactly two cases: `To Triage` on arrival, and `Backlog` when
  `In Progress` goes stale.
- **`Iteration`** is when work is scheduled and, once past, what was scheduled
  when. Automation never reads it and never writes it. Filter views with
  `iteration:@current`; group insights charts by `Status` and filter by
  iteration.

This is deliberate. GitHub's own guidance is to
[have a single source of truth](https://docs.github.com/en/issues/planning-and-tracking-with-projects/learning-about-projects/best-practices-for-projects#have-a-single-source-of-truth)
rather than spread one fact across multiple fields, and none of the
[built-in Status automations](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-built-in-automations)
key off an iteration. An earlier version of these scripts derived
`In Progress` from `Iteration = @current AND assignees >= 1`. That gave one fact
two owners: humans edited `Status` directly, automation recomputed it hourly, and
the two disagreed. A human moving a card out of `In Progress` mid-iteration was
silently reverted within the hour, `In Progress` with a future iteration was
never corrected at all, and `Status`-keyed reports lagged reality by up to a day.

## How staleness is measured

`ProjectV2ItemFieldSingleSelectValue` carries its own `updatedAt`, which moves
only when that field's value changes. So the Status value's `updatedAt` is the
item's age in its current stage, not a last-touched proxy for the whole item.

Two properties follow:

- It ignores commits, comments, and reviews. A hard task genuinely worked on for
  three weeks still reads as stale on day 14. It will be demoted, and nothing
  re-promotes it. Setting it back to `In Progress` restarts the clock, and that
  manual override is the intended escape hatch.
- Demotion itself resets the timestamp, so an item cannot be swept or commented
  on again for another 14 days no matter how often the workflow runs.

Closed issues and merged PRs still reading `In Progress` are skipped. That
inconsistency belongs to the built-in "closed → Done" workflow; sending finished
work to `Backlog` would make the board worse.

## Setup

These scripts mutate the org-level project, which the default `GITHUB_TOKEN`
can't do, so the workflows mint an installation token from a dedicated GitHub
App instead.

A PAT would also work, but it is the wrong shape for scheduled automation.
Every PAT a person holds shares one 5,000 points/hour GraphQL budget keyed to
their user ID, along with every OAuth app and CLI they have authorized. Sweeps
paginating `ProjectV2` items at roughly 30 points a page will quietly eat that
budget and then break whatever else that human was doing. An installation token
owned by `griptape-ai` gets its own 10,000 points/hour GraphQL budget, separate
from any person.

### Register the App

There is no API that creates a GitHub App, so this step is a browser click.
This link prefills every field:

<https://github.com/organizations/griptape-ai/settings/apps/new?name=Griptape+Projects&url=https%3A%2F%2Fgithub.com%2Fgriptape-ai%2F.github&public=false&issues=write&pull_requests=write&organization_projects=write>

Confirm these are set before clicking **Create GitHub App**, since URL
prefill is best-effort and silently drops anything it does not recognize:

| Scope | Permission | Why |
|---|---|---|
| Organization | **Projects: Read and write** | Read items, write `Status`. Must be the *organization* permission, not the repository one, which covers classic repo projects instead. |
| Repository | **Issues: Read and write** | The triage search, and the comment on each demotion. |
| Repository | **Pull requests: Read and write** | Comments on PR items. |

Webhooks stay off. Nothing listens for events, and the prefill link leaves
them disabled.

Then **Install App** on **All repositories**. The triage sweep searches issues
org-wide and silently skips anything the installation cannot see. Installing
is also browser-only for an org-owned App: the programmatic install endpoints
only work for enterprise-owned Apps, and require a separate bootstrap App plus
enterprise owner rights.

Write on Issues and Pull requests exists only for the explanatory comment.
Without it, `stale-in-progress.mjs` still demotes but every move lands silently,
which is the behaviour the comment exists to prevent. Widening an already-
installed App's permissions needs an org owner to approve the request on the
installation before the new scopes take effect.

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

## Local development

```sh
cd .github/scripts
npm install
PROJECTS_TOKEN=ghp_xxx PROJECT_OWNER=griptape-ai PROJECT_NUMBER=2 DRY_RUN=true \
  node triage-new-issues.mjs
PROJECTS_TOKEN=ghp_xxx PROJECT_OWNER=griptape-ai PROJECT_NUMBER=2 DRY_RUN=true \
  node stale-in-progress.mjs
```

`DRY_RUN=true` logs every flip without making any GraphQL mutations, comments
included. Use this to confirm behaviour before letting the cron loose.

The threshold is `STALE_DAYS`, default 14. Override it on a dry run to exercise
the demotion path on a board with nothing stale yet:

```sh
PROJECTS_TOKEN=ghp_xxx PROJECT_OWNER=griptape-ai PROJECT_NUMBER=2 DRY_RUN=true \
  STALE_DAYS=0 node stale-in-progress.mjs
```

The scheduled workflow never sets it.

For local runs, `PROJECTS_TOKEN` can be a fine-grained PAT with the same
permissions as the App (org Projects write, repo Issues write, repo Pull
requests write, all repositories). Keep that PAT for local use only. Pointing
the scheduled workflows at it puts the sweeps back on your personal rate
limit.

## Field assumptions

The scripts resolve field IDs by name on every run, so renaming a field breaks
them loudly (with a clear error) rather than silently misbehaving. Required:

- `Status` (single-select) with options `To Triage`, `Backlog`, `In Progress`

Only the options a script writes are resolved. `In Review`, `Done`, and
`Blocked` can be renamed or removed without touching this code, and `Iteration`
is not required at all. If `Status` or one of those three option names changes,
update the strings in `project-helpers.mjs`.

## What these workflows deliberately do not do

- They never read or write `Iteration`. Scheduling is a human decision and past
  iterations are the historical record; automation clearing that field would
  destroy per-iteration reporting.
- They never move items into `In Progress`. Starting work is a human act. The
  earlier auto-promotion is what made `Status` untrustworthy.
- They never move items into `In Review`, `Done`, or `Blocked`. The first two are
  handled by built-in project workflows (PR opened → In Review, issue closed →
  Done); `Blocked` is intentionally manual because it requires context only a
  human has.
- They never archive items. Auto-archive is a built-in project workflow;
  configure it on the project itself.
