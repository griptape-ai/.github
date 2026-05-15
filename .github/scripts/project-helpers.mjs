import { graphql, GraphqlResponseError } from "@octokit/graphql";

const PAGE_SIZE = 100;

export function makeClient() {
  const token = process.env.PROJECTS_TOKEN;
  if (!token) {
    throw new Error("PROJECTS_TOKEN env var is required");
  }
  return graphql.defaults({
    headers: { authorization: `token ${token}` },
  });
}

export function projectCoords() {
  const owner = process.env.PROJECT_OWNER;
  const number = Number(process.env.PROJECT_NUMBER);
  if (!owner || !Number.isInteger(number)) {
    throw new Error("PROJECT_OWNER and PROJECT_NUMBER env vars are required");
  }
  return { owner, number };
}

// Resolve project ID and field metadata (IDs + option IDs) by human name so the
// scripts stay correct if a field is recreated.
export async function loadProjectMetadata(client) {
  const { owner, number } = projectCoords();
  const data = await client(
    `
    query($owner: String!, $number: Int!) {
      organization(login: $owner) {
        projectV2(number: $number) {
          id
          fields(first: 50) {
            nodes {
              __typename
              ... on ProjectV2FieldCommon { id name }
              ... on ProjectV2SingleSelectField {
                id name
                options { id name }
              }
              ... on ProjectV2IterationField {
                id name
                configuration {
                  iterations { id title startDate duration }
                  completedIterations { id title startDate duration }
                }
              }
            }
          }
        }
      }
    }
    `,
    { owner, number },
  );

  const project = data.organization?.projectV2;
  if (!project) {
    throw new Error(`Project ${owner}/projects/${number} not found or not accessible`);
  }

  const fields = project.fields.nodes;
  const status = fields.find((f) => f.name === "Status");
  const iteration = fields.find((f) => f.name === "Iteration");
  if (!status || !iteration) {
    throw new Error("Project must have Status and Iteration fields");
  }

  const statusOption = (name) => {
    const opt = status.options.find((o) => o.name === name);
    if (!opt) throw new Error(`Status option "${name}" not found`);
    return opt.id;
  };

  return {
    projectId: project.id,
    statusFieldId: status.id,
    iterationFieldId: iteration.id,
    statusOptionIds: {
      toTriage: statusOption("To Triage"),
      backlog: statusOption("Backlog"),
      inProgress: statusOption("In Progress"),
      inReview: statusOption("In Review"),
      done: statusOption("Done"),
      blocked: statusOption("Blocked"),
    },
    iterations: {
      active: iteration.configuration.iterations,
      completed: iteration.configuration.completedIterations,
    },
  };
}

// The "current" iteration is whichever active iteration today falls inside.
// Iterations are stored as startDate (YYYY-MM-DD) + duration (days).
export function currentIterationId(iterations) {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  for (const it of iterations.active) {
    const start = new Date(`${it.startDate}T00:00:00Z`);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + it.duration);
    if (today >= start && today < end) return it.id;
  }
  return null;
}

// Iteration value is "ended" if its (startDate + duration) is on or before today.
// Used for the rollover sweep.
export function isIterationEnded(iterationValue) {
  if (!iterationValue) return false;
  const start = new Date(`${iterationValue.startDate}T00:00:00Z`);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + iterationValue.duration);
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  return end <= today;
}

// Walk every project item, yielding the bits we care about: status option ID,
// iteration value, and assignee count from the underlying issue/PR. Items
// whose `content` field 403s (e.g. issue lives in a repo the token can't see)
// are surfaced via partial-data errors; we log the paths and use whatever
// resolved instead of failing the whole sweep.
export async function* iterateProjectItems(client) {
  const { owner, number } = projectCoords();
  let cursor = null;
  while (true) {
    let data;
    try {
      data = await client(
      `
      query($owner: String!, $number: Int!, $cursor: String) {
        organization(login: $owner) {
          projectV2(number: $number) {
            items(first: ${PAGE_SIZE}, after: $cursor) {
              pageInfo { hasNextPage endCursor }
              nodes {
                id
                isArchived
                updatedAt
                fieldValues(first: 30) {
                  nodes {
                    __typename
                    ... on ProjectV2ItemFieldSingleSelectValue {
                      field { ... on ProjectV2SingleSelectField { name } }
                      optionId
                      name
                    }
                    ... on ProjectV2ItemFieldIterationValue {
                      field { ... on ProjectV2IterationField { name } }
                      iterationId
                      title
                      startDate
                      duration
                    }
                  }
                }
                content {
                  __typename
                  ... on Issue {
                    number
                    state
                    repository { nameWithOwner }
                    assignees(first: 1) { totalCount }
                  }
                  ... on PullRequest {
                    number
                    state
                    repository { nameWithOwner }
                    assignees(first: 1) { totalCount }
                  }
                }
              }
            }
          }
        }
      }
      `,
      { owner, number, cursor },
    );
    } catch (err) {
      if (!(err instanceof GraphqlResponseError) || !err.response?.data) throw err;
      for (const e of err.errors ?? []) {
        console.warn(`partial-data error at ${(e.path ?? []).join(".")}: ${e.message}`);
      }
      data = err.response.data;
    }

    const page = data.organization.projectV2.items;
    for (const item of page.nodes) {
      if (item.isArchived) continue;
      const status = item.fieldValues.nodes.find(
        (v) => v.__typename === "ProjectV2ItemFieldSingleSelectValue" && v.field?.name === "Status",
      );
      const iteration = item.fieldValues.nodes.find(
        (v) => v.__typename === "ProjectV2ItemFieldIterationValue" && v.field?.name === "Iteration",
      );
      yield {
        id: item.id,
        statusOptionId: status?.optionId ?? null,
        statusName: status?.name ?? null,
        iterationId: iteration?.iterationId ?? null,
        iterationValue: iteration ?? null,
        assigneeCount: item.content?.assignees?.totalCount ?? 0,
        updatedAt: item.updatedAt ?? null,
        contentRef: item.content
          ? `${item.content.repository?.nameWithOwner}#${item.content.number}`
          : "(draft)",
      };
    }

    if (!page.pageInfo.hasNextPage) return;
    cursor = page.pageInfo.endCursor;
  }
}

export async function setStatus(client, projectId, statusFieldId, itemId, optionId) {
  await client(
    `
    mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
      updateProjectV2ItemFieldValue(input: {
        projectId: $projectId
        itemId: $itemId
        fieldId: $fieldId
        value: { singleSelectOptionId: $optionId }
      }) { projectV2Item { id } }
    }
    `,
    { projectId, itemId, fieldId: statusFieldId, optionId },
  );
}

// Walk every open issue in the org that is NOT already on the project. Used by
// the triage sweep to pull newly created issues onto the board. Search
// excludes pull requests via `is:issue` and excludes anything already on the
// project via `-project:OWNER/NUMBER`.
export async function* searchUntriagedIssues(client) {
  const { owner, number } = projectCoords();
  const queryString = `is:issue is:open org:${owner} -project:${owner}/${number}`;
  let cursor = null;
  while (true) {
    const data = await client(
      `
      query($q: String!, $cursor: String) {
        search(query: $q, type: ISSUE, first: ${PAGE_SIZE}, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            ... on Issue {
              id
              number
              repository { nameWithOwner }
            }
          }
        }
      }
      `,
      { q: queryString, cursor },
    );

    for (const node of data.search.nodes) {
      if (!node?.id) continue;
      yield {
        contentId: node.id,
        contentRef: `${node.repository.nameWithOwner}#${node.number}`,
      };
    }

    if (!data.search.pageInfo.hasNextPage) return;
    cursor = data.search.pageInfo.endCursor;
  }
}

// Add an issue/PR to the project. Idempotent: if the item already exists, the
// API returns the existing item ID rather than erroring.
export async function addItemToProject(client, projectId, contentId) {
  const data = await client(
    `
    mutation($projectId: ID!, $contentId: ID!) {
      addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
        item { id }
      }
    }
    `,
    { projectId, contentId },
  );
  return data.addProjectV2ItemById.item.id;
}

export async function clearIteration(client, projectId, iterationFieldId, itemId) {
  await client(
    `
    mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!) {
      clearProjectV2ItemFieldValue(input: {
        projectId: $projectId
        itemId: $itemId
        fieldId: $fieldId
      }) { projectV2Item { id } }
    }
    `,
    { projectId, itemId, fieldId: iterationFieldId },
  );
}
