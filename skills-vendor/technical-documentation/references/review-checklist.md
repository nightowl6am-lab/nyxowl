# Documentation review checklist

Use the sections that apply to the document. A checked box means that the draft
contains evidence for the claim, not only that the item was considered.

## Technical accuracy

- [ ] Product names, code symbols, UI labels, and terminology match the source.
- [ ] Commands, flags, paths, and configuration keys exist.
- [ ] Prerequisites, permissions, defaults, and limits are accurate.
- [ ] Version and compatibility claims identify their scope.
- [ ] Code samples compile or run when verification is practical.
- [ ] Expected output is representative and clearly labeled.
- [ ] Error behavior, side effects, and cleanup steps are accurate.
- [ ] Security-sensitive steps use safe examples and don't expose secrets.
- [ ] Unsupported or unverified claims are removed or explicitly qualified.

## Audience and purpose

- [ ] The intended audience is clear.
- [ ] The opening states what the reader can do or understand.
- [ ] Assumed knowledge and prerequisites are appropriate.
- [ ] The document answers one coherent reader need.
- [ ] Background information supports the task instead of delaying it.
- [ ] The scope excludes unrelated implementation detail.

## Task completion

- [ ] Steps appear in the order that the reader performs them.
- [ ] Each step begins with an imperative verb.
- [ ] Each step contains one main action.
- [ ] The location or environment appears before the action.
- [ ] Optional steps begin with `Optional:`.
- [ ] Placeholders are explained where the reader encounters them.
- [ ] The reader can verify the final result.
- [ ] Likely, costly failures include actionable recovery guidance.
- [ ] Persistent, billable, or sensitive resources include cleanup guidance.

## Structure and navigation

- [ ] The document type matches the reader's goal.
- [ ] Critical information appears before secondary detail.
- [ ] The page has one descriptive level-1 heading.
- [ ] Headings use sentence case and don't skip hierarchy levels.
- [ ] Task headings start with a bare verb.
- [ ] Conceptual headings use descriptive noun phrases.
- [ ] Every heading has associated content.
- [ ] Lists and tables have an introduction when context is needed.
- [ ] Tables are used only for genuinely tabular, comparable information.

## Clarity and tone

- [ ] The document addresses the reader as "you."
- [ ] Instructions use imperative verbs.
- [ ] Sentences use active voice unless passive voice serves a clear purpose.
- [ ] Sentences use present tense when practical.
- [ ] Paragraphs focus on one idea and put the key point first.
- [ ] Long sentences and paragraphs have been reviewed for simpler structure.
- [ ] Terms are precise, defined when needed, and used consistently.
- [ ] Abbreviations are defined on first use.
- [ ] Filler, repetition, and unnecessary qualifiers are removed.
- [ ] The draft avoids "easy," "simple," "obvious," "just," and similar claims.
- [ ] The tone is conversational and respectful without slang or hype.

## Code and formatting

- [ ] Code blocks have accurate language identifiers.
- [ ] Code examples are minimal, complete enough to use, and project-formatted.
- [ ] Commands and output are separated and labeled.
- [ ] Code-related names and literal input use code font.
- [ ] Visible UI labels use bold and match the interface.
- [ ] List items use parallel grammar and consistent punctuation.
- [ ] Bold and italics convey meaning rather than decoration.
- [ ] Placeholder values use a consistent, distinguishable format.

## Links

- [ ] Link text describes its destination when read out of context.
- [ ] Links point to the most specific relevant page or section.
- [ ] The page avoids "click here," "this document," and raw URL link text.
- [ ] Cross-references explain why the destination is relevant.
- [ ] Downloads and unexpected link behavior are disclosed.
- [ ] Duplicate and low-value links are removed.
- [ ] Links resolve successfully.

## Accessibility and inclusion

- [ ] The heading hierarchy and other structures are semantic.
- [ ] Informative images have meaningful alt text.
- [ ] Decorative images have empty alt text.
- [ ] Text provides the information conveyed by images, audio, and video.
- [ ] Meaning doesn't depend only on color, position, direction, shape, or size.
- [ ] Instructions refer to accessible labels instead of visual appearance.
- [ ] Link text and headings remain meaningful to screen-reader users.
- [ ] Language avoids ableist, violent, and unnecessarily gendered terms.
- [ ] Examples represent people respectfully and avoid stereotypes.
- [ ] The document avoids idioms, metaphors, jokes, and culture-specific cues.
- [ ] Dates, times, units, and number formats are unambiguous.

## Final quality gate

- [ ] A reader can identify the purpose by scanning the title and opening.
- [ ] A reader can complete the stated goal without undocumented knowledge.
- [ ] Every factual claim is verified, sourced, or explicitly qualified.
- [ ] The document follows project-specific guidance before this checklist.
- [ ] Any intentional style departure improves clarity and is consistent.

## Review finding format

Report only findings that materially affect correctness, completion,
accessibility, safety, or comprehension:

```text
[SEVERITY] SECTION: concise problem statement
Impact: what the reader might misunderstand or fail to do
Suggested change: concrete replacement or structural fix
Evidence: source code, API schema, product behavior, or style-guide link
```

Use `critical` for unsafe or unusable instructions, `major` for incorrect or
task-blocking content, and `minor` for a meaningful clarity or consistency
problem. Don't report subjective preference as a defect.
