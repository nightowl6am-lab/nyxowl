# Document patterns

Choose the smallest pattern that supports the reader's goal. Delete sections
that don't add value; don't publish empty template headings.

## README

Use a README to orient a new contributor or user and provide the shortest path
to a working result.

```markdown
# PROJECT_NAME

One paragraph that explains what the project does, who it is for, and why a
reader would use it.

## Quick start

State what the reader will accomplish.

### Prerequisites

- Required tool and supported version
- Required account, permission, or service

### Install

1. Install the project:

   ```shell
   INSTALL_COMMAND
   ```

2. Configure the required values in `CONFIG_FILE`.

### Run

Run the project:

```shell
RUN_COMMAND
```

Expected result:

```text
EXPECTED_OUTPUT
```

## Common tasks

Link to the most important task-oriented guides.

## Configuration

Document required values, defaults, allowed values, and security implications.

## Development

List the commands needed to test, lint, build, and contribute.

## Support

Explain where to report defects and ask questions.
```

## How-to guide

Use a how-to guide for one practical goal. Assume that the reader understands
the core concepts unless the procedure depends on a brief explanation.

```markdown
# VERB + GOAL

This guide shows you how to OUTCOME.

## Prerequisites

- PREREQUISITE

## Complete the task

1. Start with an imperative action.
2. Add one main action per step.
3. Put commands where the reader runs them.

## Verify the result

Run CHECK_COMMAND.

The output includes EXPECTED_SIGNAL.

## Troubleshoot COMMON_FAILURE

State the symptom, likely cause, diagnostic action, and recovery action.
```

## Tutorial

Use a tutorial for a guided learning experience that produces a working result.
Keep the path linear and explain only the concepts that support the next action.

```markdown
# Build OUTCOME

In this tutorial, you build OUTCOME by using TECHNOLOGY. You learn how to
CONCEPTUAL_GOAL.

## What you build

Describe the finished result and include a useful preview when available.

## Prerequisites

- REQUIRED_KNOWLEDGE
- REQUIRED_TOOL and VERSION

## Set up the project

Provide reproducible setup steps.

## Build the first working slice

Explain the immediate goal, provide the steps, and verify the result.

## Add CAPABILITY

Build on the verified result. Explain new concepts at the point of use.

## Verify the application

Provide a final end-to-end check and expected behavior.

## Clean up

Explain how to remove billable, persistent, or security-sensitive resources.

## Next steps

Link to no more than a few direct continuations.
```

## Concept document

Use a concept document to help the reader make decisions or form an accurate
mental model. Don't disguise a procedure as a concept document.

```markdown
# CONCEPT

Define the concept and explain why it matters.

## How CONCEPT works

Explain the model from the reader's perspective. Introduce terminology before
using it.

## Key components

Describe each component's responsibility and relationship to the others.

## Lifecycle or data flow

Explain sequence and state changes. Use a diagram only when it improves the
text explanation.

## Design considerations

Explain constraints, tradeoffs, limits, and security implications.

## When to use CONCEPT

Give concrete selection criteria and alternatives.
```

## API reference

Use an API reference for precise lookup. Generate facts from the API schema or
source where possible, and keep terminology consistent with the implementation.

```markdown
# API_NAME reference

One paragraph that states the API's purpose, base version, and authentication
model.

## ENDPOINT_OR_SYMBOL

`METHOD PATH_OR_SIGNATURE`

Describe the operation in one sentence.

### Authorization

State the required permission or scope.

### Parameters

| Name | Location | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `PARAMETER` | path | string | Yes | Include constraints and format. |

### Request

Introduce a minimal valid request.

### Response

State the success status, schema, and meaningful side effects.

### Errors

| Status or error | Cause | Recovery |
| --- | --- | --- |
| `ERROR` | CONDITION | ACTION |

### Example

Provide a verified request and representative response.
```

For libraries, replace endpoint details with signature, parameters, return
value, exceptions, side effects, thread-safety or state considerations, and a
minimal example.

## Troubleshooting guide

Use a troubleshooting guide when readers can identify a symptom but don't know
the cause.

```markdown
# Troubleshoot SYSTEM

Explain the covered environment and where to collect diagnostics.

## SYMPTOM_AS_READER_SEES_IT

### Cause

Explain the verified cause and the conditions that trigger it.

### Diagnose

1. Run or inspect DIAGNOSTIC.
2. Compare the result with EXPECTED_SIGNAL.

### Resolve

1. Apply the least disruptive recovery action.
2. Verify that the symptom no longer occurs.

### Prevent recurrence

Document prevention only when it is known and actionable.
```

Use the exact error text as a heading only when readers are likely to search for
it. Never include secrets, tokens, or personal data in diagnostic examples.

## Release note

Use a release note to explain impact, not implementation history.

```markdown
## FEATURE_OR_CHANGE

Starting in VERSION_OR_DATE, PRODUCT changes BEHAVIOR. This change affects
AUDIENCE_OR_SCENARIO.

If action is required, complete ACTION before DEADLINE_OR_UPGRADE.

For migration steps, see [DESCRIPTIVE_GUIDE_TITLE](URL).
```

Include availability, compatibility, migration, deprecation, and rollback
details only when they apply. Avoid promotional language and internal project
names.

## Decision record

Use a decision record for a consequential choice that future maintainers might
otherwise revisit without the original context.

```markdown
# DECISION_TITLE

## Status

Proposed | Accepted | Superseded | Deprecated

## Context

Describe the problem, constraints, and forces that make a decision necessary.

## Decision

State the choice and the reasoning.

## Alternatives

Describe viable alternatives and why they were not selected.

## Consequences

List benefits, costs, risks, operational effects, and follow-up work.
```
