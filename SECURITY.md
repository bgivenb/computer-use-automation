# Security

Please report suspected vulnerabilities privately through GitHub's security advisory feature. Do not include credentials, production data, or exploit details in a public issue.

The included target and evidence use synthetic records and bind only to loopback. Reports should reproduce against the current default branch without introducing real customer or account data.

## Credentials, evidence, and approvals

Keep provider credentials in the process environment or an ignored local `.env` file. Never include
them in a capability, policy, screenshot, issue, or recording. Rotate a key if it has been shared
outside its intended secret store. Text redaction is not screenshot DLP: discovery sends screenshots
to the configured provider, so use only synthetic or explicitly approved screen contents.

The approval-gated `run` command verifies the exact artifact and runtime policy against an independently
configured public key before opening a browser. Reviewer private keys belong outside the repository
and are generated with owner-only permissions. Approvals expire (24 hours by default, at most seven
days); any artifact or policy change requires review again. The reviewer's display name is metadata,
not proof of organizational identity. Revoke a key by removing it from your trusted configuration.

This local gate protects against accidental or unapproved artifact changes, not a malicious process
owner who can modify the runtime or its trusted-key argument. The synthetic `replay` demo bypasses
approval deliberately. The loopback operator console is not a remotely authenticated control plane;
do not expose it through a public tunnel or deploy it as a multi-tenant service.
