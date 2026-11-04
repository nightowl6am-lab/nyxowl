# Google developer documentation style guidance

Use this reference when a documentation task needs more detail than the core
skill provides. It distills the Google developer documentation style guide; it
does not replace the source.

Project-specific guidance takes precedence. Clarity and consistency take
precedence over mechanical compliance.

## Voice and tone

- Sound like a knowledgeable colleague: friendly, direct, and respectful.
- Keep the focus on useful information. Don't aim for entertainment or a formal,
  academic voice.
- Address the reader as "you." Use third person for software behavior or for the
  users of software that the reader develops.
- Use the imperative mood in instructions.
- Prefer active voice so that the actor is clear. Passive voice is acceptable
  when the actor is irrelevant or the object deserves emphasis.
- Avoid slang, excessive politeness, exclamation marks, pop-culture references,
  and overly cute language.

Sources:

- [Voice and tone](https://developers.google.com/style/tone)
- [Active voice](https://developers.google.com/style/voice)
- [Second person and first person](https://developers.google.com/style/person)

## Clear and global writing

- Prefer familiar words: use "start" instead of "commence" and "use" instead of
  "utilize."
- Keep the subject and verb near the start of a sentence.
- Put a condition before the instruction that depends on it.
- Use present tense and uncomplicated verb forms.
- Repeat a noun when a pronoun could have an unclear antecedent.
- Define abbreviations on first use.
- Use one term for one concept, including consistent capitalization.
- Avoid idioms, metaphors, phrasal verbs, humor, and culturally specific
  examples when a literal alternative is available.
- Write short sentences. Google's accessibility guidance suggests aiming for
  fewer than 26 words.

Sources:

- [Writing for a global audience](https://developers.google.com/style/translation)
- [Accessible content](https://developers.google.com/style/accessibility)
- [Inclusive documentation](https://developers.google.com/style/inclusive-documentation)

## Paragraphs and information order

- Give each paragraph one main idea.
- Put the most important information in the first sentence.
- Break up walls of text, but don't split a single idea only to create short
  paragraphs.
- Treat paragraphs longer than five or six sentences as a signal to review the
  structure.
- Left-align text. Don't force line breaks inside sentences or paragraphs.

Source: [Paragraph structure](https://developers.google.com/style/paragraph-structure)

## Headings

- Use sentence case.
- Use a unique level-1 heading once per page.
- Use descriptive headings that help readers navigate without surrounding
  context.
- Begin task headings with a bare verb: "Configure authentication."
- Use noun phrases for concepts: "Authentication model."
- Start optional section headings with `Optional:`.
- Avoid leading gerunds, links, sequence numbers, code-only headings, and
  complicated punctuation.
- Don't skip heading levels or place headings next to each other without
  introductory content.

Source: [Headings and titles](https://developers.google.com/style/headings)

## Lists

- Use numbered lists for sequences and bullets for unordered items.
- Don't create a list that contains only one item.
- Introduce a list with a complete sentence when the heading doesn't provide
  enough context.
- Use parallel grammar and consistent punctuation.
- Start items with a capital letter.
- Omit end punctuation for single words, short verbless phrases, code-only
  items, and link-only items. Otherwise, use sentence punctuation consistently.
- Use a description list when several terms each need an explanation.

Source: [Lists](https://developers.google.com/style/lists)

## Procedures

- Introduce a procedure when the heading alone doesn't provide enough context.
- Use a numbered list and start each step with an imperative verb.
- For one step, use a bullet and one sentence.
- Put context before action: "In the console, click **Save**."
- Put a step's goal before its action and the result after its action.
- Keep one main action per step. Split steps that become long.
- Start optional steps with `Optional:`.
- Prefer one accessible method. If multiple methods are necessary, separate them
  with headings, pages, or tabs.
- Reuse an existing procedure through a precise link instead of repeating it.

Source: [Procedures](https://developers.google.com/style/procedures)

## Code and technical text

- Use code font for code-related names, commands, filenames, paths, methods,
  fields, data types, literal values, and user-entered text.
- Add a descriptive noun when it improves grammar, such as "the `config.yaml`
  file."
- Introduce a code sample with a sentence that explains its purpose.
- Follow the relevant language or project code style.
- Prefer spaces to tabs unless the language or project requires tabs.
- Wrap long sample lines when wrapping doesn't change behavior.
- Indicate omitted code with a language-appropriate comment, not an ellipsis.
- Keep commands, output, and explanations visually distinct.

Sources:

- [Code in text](https://developers.google.com/style/code-in-text)
- [Code samples](https://developers.google.com/style/code-samples)

## UI elements

- Focus on the goal rather than the widget when the UI action is obvious.
- Use the visible label and format it in bold.
- Match the UI's capitalization unless the UI is inconsistent or uses all caps;
  then use sentence case.
- Refer to a button by its label: "Click **Save**," not "Click the Save button."
- Put the location before the action.
- Don't rely on icon appearance, direction, or position. Use the accessible name
  or tooltip.

Source: [UI elements and interaction](https://developers.google.com/style/ui-elements)

## Links

- Link selectively; every link adds a decision and a possible exit from the
  task.
- Prefer local context for short explanations.
- Use the destination title or a concise descriptive phrase as link text.
- Put distinguishing words early in the link text.
- Don't use "click here," "this document," or a URL as ordinary link text.
- Link to the most specific useful destination.
- Explain unexpected behavior, such as downloading a file or opening a new
  window.
- Don't force a new tab unless necessary.

Source: [Cross-references and linking](https://developers.google.com/style/cross-references)

## Text formatting

- Use bold mainly for UI labels and run-in headings.
- Use italics sparingly for introduced terms, words as words, or semantic
  emphasis.
- Reserve underlining for links.
- Use code font for technical literals and code-related names.
- Use sentence case for headings, titles, and navigation.
- Use uppercase for placeholder values.
- Use "and" instead of an ampersand except when reproducing a UI label or code.

Source: [Text-formatting summary](https://developers.google.com/style/text-formatting)

## Accessibility and inclusion

- Use semantic elements and a logical heading hierarchy.
- Make link text meaningful when read out of context.
- Provide alt text that communicates an informative image's purpose. Use empty
  alt text for decorative images.
- Provide a text equivalent for information in images, video, or audio.
- Don't use images of text, code, or terminal output.
- Don't rely on color, location, shape, or size as the only signal.
- Avoid ableist, violent, unnecessarily gendered, and socially charged
  metaphors.
- Respect the terminology preferred by the people and communities described.
- Use precise, literal language that translates reliably.

Sources:

- [Accessible content](https://developers.google.com/style/accessibility)
- [Inclusive documentation](https://developers.google.com/style/inclusive-documentation)

## Rule of judgment

The Google guide explicitly describes its guidance as recommendations rather
than absolute rules. Depart when the audience, domain, product, or project has a
clearer convention. Document important exceptions and use them consistently.

Source: [Google developer documentation style guide](https://developers.google.com/style)
