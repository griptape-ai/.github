// Sweep "In Progress" items back to "Backlog" in two situations:
//   1. The item has an iteration value and that iteration has ended.
//   2. The item has no iteration at all and has been sitting that way longer
//      than the orphan grace period.
//
// Rationale: "In Progress" without a current/future iteration means the work
// was claimed but slipped past its sprint, or someone forgot to schedule it.
// Returning it to Backlog forces a deliberate replan rather than letting it
// sit as silent rot.
//
// The grace period exists so we don't punish someone mid-triage who flipped
// status before iteration during the same session. The project item's
// `updatedAt` bumps on any field change, so it's a conservative "has this
// been touched recently?" signal: as long as somebody is actively editing the
// item, we leave it alone.
//
// Items in "In Review" / "Done" / "Blocked" are left alone. Items whose
// iteration is still active or in the future are left alone.

import {
  makeClient,
  loadProjectMetadata,
  iterateProjectItems,
  setStatus,
  clearIteration,
  isIterationEnded,
} from "./project-helpers.mjs";

const DRY_RUN = process.env.DRY_RUN === "true";

// How long an item may sit as "In Progress" with no iteration before we sweep
// it back to Backlog. Tuned to comfortably exceed a normal triage session.
const ORPHAN_GRACE_HOURS = 24;

function isOrphanStale(updatedAt) {
  if (!updatedAt) return false;
  const updated = new Date(updatedAt).getTime();
  if (Number.isNaN(updated)) return false;
  const cutoff = Date.now() - ORPHAN_GRACE_HOURS * 60 * 60 * 1000;
  return updated <= cutoff;
}

async function main() {
  const client = makeClient();
  const meta = await loadProjectMetadata(client);

  let scanned = 0;
  let endedRolledOver = 0;
  let orphansRolledOver = 0;
  for await (const item of iterateProjectItems(client)) {
    scanned += 1;
    if (item.statusOptionId !== meta.statusOptionIds.inProgress) continue;

    if (item.iterationValue) {
      if (!isIterationEnded(item.iterationValue)) continue;

      endedRolledOver += 1;
      console.log(
        `${DRY_RUN ? "[dry-run] " : ""}${item.contentRef}: In Progress (${item.iterationValue.title}) -> Backlog (iteration cleared)`,
      );
      if (!DRY_RUN) {
        await setStatus(
          client,
          meta.projectId,
          meta.statusFieldId,
          item.id,
          meta.statusOptionIds.backlog,
        );
        await clearIteration(client, meta.projectId, meta.iterationFieldId, item.id);
      }
      continue;
    }

    if (!isOrphanStale(item.updatedAt)) continue;

    orphansRolledOver += 1;
    console.log(
      `${DRY_RUN ? "[dry-run] " : ""}${item.contentRef}: In Progress (no iteration, idle since ${item.updatedAt}) -> Backlog`,
    );
    if (!DRY_RUN) {
      await setStatus(
        client,
        meta.projectId,
        meta.statusFieldId,
        item.id,
        meta.statusOptionIds.backlog,
      );
    }
  }

  console.log(
    `Scanned ${scanned} items, rolled ${endedRolledOver} ended-iteration and ${orphansRolledOver} orphan items back to Backlog.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
