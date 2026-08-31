// Sweep items that have claimed "In Progress" for too long back to "Backlog".
//
// Signal: the Status field value's own `updatedAt`, which moves only when Status
// changes. That makes it age-in-stage, answering exactly one question: how long
// has this card claimed to be in progress without anyone revisiting the claim.
//
// This deliberately reads nothing else. Not Iteration, not assignees, not issue
// activity. Status is the only field automation writes and it is derived from no
// other field, so the board cannot contradict itself and a Status-keyed report
// cannot disagree with a differently-keyed one.
//
// Every demotion comments on the item explaining itself. Silent moves are what
// confuse people, so the mutation and its explanation ship together.
//
// Consequence worth naming: work that legitimately runs longer than the
// threshold gets demoted mid-flight, and nothing re-promotes it. Moving it back
// to In Progress restarts the clock. That manual override is the design, not a
// workaround.

import {
  makeClient,
  loadProjectMetadata,
  iterateProjectItems,
  setStatus,
  addComment,
} from "./project-helpers.mjs";

const DRY_RUN = process.env.DRY_RUN === "true";

// Two work weeks without a status change. Long enough that a normal task
// finishes or moves first, short enough that abandoned work surfaces while
// anyone still remembers it. Overridable only to make dry runs exercise the
// demotion path against a board that has no stale items yet.
const STALE_DAYS = Number(process.env.STALE_DAYS ?? 14);
if (!Number.isInteger(STALE_DAYS) || STALE_DAYS < 0) {
  throw new Error(`STALE_DAYS must be a non-negative integer, got "${process.env.STALE_DAYS}"`);
}

const MARKER = "<!-- griptape-stale-in-progress -->";
const RULES_URL =
  "https://github.com/griptape-ai/.github/blob/main/.github/scripts/README.md";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function daysInStatus(statusUpdatedAt) {
  if (!statusUpdatedAt) return null;
  const changed = new Date(statusUpdatedAt).getTime();
  if (Number.isNaN(changed)) return null;
  return Math.floor((Date.now() - changed) / MS_PER_DAY);
}

function staleComment(assignees, days) {
  const mention = assignees.length ? `${assignees.map((l) => `@${l}`).join(" ")} ` : "";
  return [
    MARKER,
    `${mention}Status has read **In Progress** for ${days} days without changing, so this moved back to **Backlog**.`,
    "",
    "That measures time since the last status change, not activity here. If the work is live, set it back to **In Progress** and the clock restarts.",
    "",
    `[Why this exists](${RULES_URL})`,
  ].join("\n");
}

async function main() {
  const client = makeClient();
  const meta = await loadProjectMetadata(client);

  let scanned = 0;
  let demoted = 0;
  let unexplained = 0;
  for await (const item of iterateProjectItems(client)) {
    scanned += 1;
    if (item.statusOptionId !== meta.statusOptionIds.inProgress) continue;

    // A closed issue or merged PR still reading In Progress is a different
    // inconsistency, owned by the built-in "closed -> Done" workflow. Sending
    // finished work to Backlog would make the board worse, not better.
    if (item.contentState && item.contentState !== "OPEN") continue;

    const days = daysInStatus(item.statusUpdatedAt);
    if (days === null || days < STALE_DAYS) continue;

    demoted += 1;
    console.log(
      `${DRY_RUN ? "[dry-run] " : ""}${item.contentRef}: In Progress for ${days}d -> Backlog`,
    );
    if (DRY_RUN) continue;

    await setStatus(
      client,
      meta.projectId,
      meta.statusFieldId,
      item.id,
      meta.statusOptionIds.backlog,
    );

    // Comment after the move so an explanation can never outlive a failed
    // mutation. The demotion resets the Status timestamp, so an item cannot be
    // commented on again for another STALE_DAYS regardless of how often this
    // runs.
    if (!item.contentId) {
      console.warn(`${item.contentRef}: demoted; draft items have nothing to comment on`);
      unexplained += 1;
      continue;
    }
    try {
      await addComment(client, item.contentId, staleComment(item.assignees, days));
    } catch (err) {
      // One repo with comments locked must not abort the sweep.
      console.warn(`${item.contentRef}: demoted but comment failed: ${err.message}`);
      unexplained += 1;
    }
  }

  console.log(
    `Scanned ${scanned} items, demoted ${demoted} stale In Progress items (>= ${STALE_DAYS}d) to Backlog.`,
  );
  if (unexplained > 0) {
    console.warn(`${unexplained} demotions went unexplained; see warnings above.`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
