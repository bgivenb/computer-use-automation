# Changelog

## 0.2.0

- Added explicit target/profile/input/policy configuration and a surface adapter port.
- Added bounded exploration alongside guided discovery. Exploration records checkpoints only after
  observing action results, and compiles drafts for review; it does not infer authorization.
- Added discovery same-session handoff with verified resume, bounded operator time and recorded actions.
- Added artifact inspection, structured revision diffs, and Ed25519 approvals bound to both artifact
  and runtime policy. Expiry, altered content and unknown trust roots fail before browser launch.
- Added nine-scenario browser evaluations, seeded approval mutation tests, and end-to-end signed invocation tests.
- Kept original provider-backed evidence and model-free replay fixtures intact.
- Preserved the MIT license and existing schema-v1 artifacts. Artifact writes now refuse overwrites;
  use a new filename for a new discovery revision.
