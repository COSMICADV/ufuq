# product-documentation/

## What this folder is for

The product specification: the numbered DOCUMENT set the whole codebase is written against.
When a comment in the code says "DOCUMENT 12 rule 4", this is the folder it means.

This is the **source of requirements**. [`../docs/`](../docs/README.md) is the record of
what has been built from them.

## What it contains

Twenty-nine documents, numbered so that references are stable. Start at
[`00-INDEX.md`](00-INDEX.md). The ones referenced most often from code:

| Document | Subject                                                      |
| -------- | ------------------------------------------------------------ |
| 02       | Roles and permissions                                        |
| 04       | Screen inventory                                             |
| 06       | Database architecture — every table and column               |
| 08       | API architecture — every endpoint, the envelope, validation  |
| 09       | Authentication and authorization                             |
| 10 / 11  | Design system and UI/UX specification                        |
| 12       | Attendance specification                                     |
| 20 / 21  | Security, and audit logging                                  |
| 22       | Responsive specification                                     |
| 25       | Development roadmap — the phases and their exit criteria     |
| 26       | Testing strategy                                             |
| 27       | The 35 development rules                                     |
| 28       | Open decisions                                               |

## Which part of the system uses it

People, and every code comment that cites a rule. Nothing imports it, and no build step
reads it.

## Important rules and dependencies

- **These files are the specification, not notes.** Code that disagrees with a document is a
  bug in one of the two; say which before changing either (DOCUMENT 27 RULES 1 and 35).
- **Document numbers are permanent.** Hundreds of code comments cite them, so a file is not
  renumbered for tidiness.
- Where a document is silent, the gap is recorded in the phase's status document rather than
  filled by invention (RULES 2 and 35).

## Should developers add files here?

Only when the product specification itself changes, and then as an amendment to the document
that owns the subject — not as a new file that quietly contradicts an existing one.
