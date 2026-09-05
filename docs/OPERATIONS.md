# Operating a capability

The standard path is discover → inspect/diff → approve → invoke. The CLI deliberately keeps the
synthetic `demo`/`replay` shortcuts separate from the approval-gated `run` command.

## Configure an authorized synthetic target

The banking example is an adapter fixture. Export its profile as a starting point:

```bash
npm run cua -- profile --target http://127.0.0.1:4173 --out .runs/profile.json
```

Adapt this JSON to your application. A profile declares inputs, outputs, goal checkpoints, artifact
permissions, and guided step semantics. `mode: "explore"` does not use the ordered step skeleton;
the model chooses from the author's unordered `checkpoints` catalog after observing each action.
Optional `onObserved` branches are reviewed global branches attached to discovered steps. A
`resumeWhen` array supplies the trusted checkpoint for discovery escalation before an action.
Post-action guided failures use the current step's checkpoint. At most two discovery handoffs are
permitted, each with a two-minute operator deadline, within a bounded discovery run.

Create separate `inputs.json` and `policy.json` files. Policy uses `origins`, `routes`, and `actions`;
it is independent of the profile and can only narrow effective permissions. Do not copy permissions
from an untrusted model artifact into the runtime policy without review.

```bash
npm run discover -- --driver openai --mode explore \
  --goal "Find the synthetic member and prepare their request through review" \
  --target http://127.0.0.1:4173/ \
  --profile .runs/profile.json --inputs .runs/inputs.json --policy .runs/policy.json \
  --synthetic --interactive --artifact .runs/draft.json
```

The application must already be running. `--target` must exactly match the profile's `entryUrl`.
The external path requires `--synthetic` because screenshot capture and transmission do not provide
general pixel-level redaction. This is not permission to automate real regulated data.

## Review and sign

```bash
npm run cua -- inspect --artifact .runs/draft.json
npm run cua -- diff --before .runs/previous.json --after .runs/draft.json
npm run cua -- keygen --directory /private/reviewer-keys
npm run cua -- approve --artifact .runs/draft.json --policy .runs/policy.json \
  --key /private/reviewer-keys/reviewer-private.pem \
  --reviewer "Reviewer name" --reason "Reviewed targets, outputs, recovery branches and policy" \
  --out .runs/approval.json
```

Replace `/private/reviewer-keys` with a new directory in a private location outside the repository.
The parent directory must exist. Key generation refuses an existing directory; output writes refuse
existing files. Private keys use mode 0600 on POSIX. Native Windows users must apply appropriate ACLs.

Review includes input parameterization, all locator fallbacks, output meaning, checkpoint quality,
recovery safety, and every permission. A signature authenticates possession of the configured key,
not a person's job title, the truth of a model claim, or operational fitness. A display name alone
does not establish identity. Approvals expire after 24 hours by default, at most seven days.

```bash
npm run cua -- run --artifact .runs/draft.json --inputs .runs/inputs.json \
  --policy .runs/policy.json --approval .runs/approval.json \
  --trusted-key /private/reviewer-keys/reviewer-public.pem
```

This validates the signature, artifact, policy, and time window before browser launch. The trusted
public key comes from caller configuration, never from the receipt. It invokes only deterministic
replay and fails closed when human intervention would be necessary. Use the interactive local replay
path to demonstrate operator handoff; remote authenticated operator routing is outside this release.

Changing an artifact or runtime policy requires a new review, even when narrowing policy. Stop
trusting a compromised public key immediately; there is no network revocation service. Trusted
embedding code can call lower-level APIs directly, so this gate is not a sandbox against a process
owner who can replace code or trust configuration. Approvals never widen the action policy and never
authorize the bank fixture's final account-creation action.

## Private working data

Keep keys, inputs, profiles containing sensitive defaults, screenshots, and live run logs out of git.
`.env` and `.runs/` are ignored; load an ignored local environment file explicitly with Node's
`--env-file=.env` when desired. Sharing a credential outside its secret store warrants rotation.
The source secret scanner intentionally does not read ignored credential files.
