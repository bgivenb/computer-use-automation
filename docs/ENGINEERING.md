# Engineering decisions

## Build the domain, adopt the mechanisms

| Responsibility | Choice | Reason |
| --- | --- | --- |
| Browser interaction and actionability | Playwright | Existing frame, locator, navigation, and browser-context behavior |
| Contracts and validation | Zod | One runtime schema also supplies TypeScript profile types |
| Provider transport and structured output | Official OpenAI SDK | Avoid handwritten HTTP, response parsing and schema conversion |
| Artifact revision diffs | jsondiffpatch | Existing structured object/array diff, including moved step identities |
| Property-based tests | fast-check | Seeded generation and shrinking, instead of a homegrown fuzzing loop |
| Approval signatures | Node crypto / Ed25519 | Standard signing primitives; no custom cryptography |
| CLI and local I/O | Node standard library | Existing parseArgs and filesystem support are sufficient |

References: [Playwright](https://playwright.dev/docs/intro), [Zod](https://zod.dev/),
[structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs),
[jsondiffpatch](https://github.com/benjamine/jsondiffpatch), and
[fast-check](https://fast-check.dev/docs/introduction/).

Custom code owns the capability meaning, permission intersection, checkpoint semantics, and session
control-transfer rules. Adding an agent framework or queue would not replace those responsibilities.
Dependencies are pinned and covered by the lockfile. No database or distributed scheduler is added.

## Act, observe, then record a checkpoint

An early exploration experiment asked the model to propose the next screen's checkpoint before
acting. It invented a combined heading that did not exist; the run correctly stopped, but the
interface encouraged guessing. Further trials exposed invalid frame roles and confusion between
top-level and iframe URLs. The provider schema now constrains frame locators to supported CSS
strategies, and exploration selects from an author-reviewed, unordered checkpoint catalog using the
*next observation* before allowing another action. It learns the sequence and action targets, not
arbitrary success semantics. Final completion still requires the author's independent success
conditions. Guided mode preserves its reviewed per-step checkpoints.

This does not make the model's choice authoritative. It must select a catalog entry that actually passes;
approval and repeated replay are separate decisions. Human repairs are logged, not silently learned
as autonomous steps. A manually assisted discovery can still need an explicit recovery branch before
unattended use.

## Separate execution trust from provenance

A successful discovery is evidence that a workflow ran once. A signed approval is a trusted review
of exact content and policy. Replay results are evidence of a particular invocation. None substitutes
for the others. Original provider-backed recordings remain intact when implementation evolves.

## Boundaries kept intentionally small

The `SurfaceAdapter` port contains observation, policy inspection, execution, checks, and capture.
The current browser human-control coordinator still uses a browser session supplied at composition.
There is no claim of desktop support or distributed leases. Screenshot DLP, organization identity,
remote operator authorization, tenant rollout and key revocation are real future requirements, not
features implied by the example's local signing gate.
