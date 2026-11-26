# Security policy

## Reporting a vulnerability

Please do not report exploitable vulnerabilities in a public issue.

Use GitHub's private vulnerability reporting flow when it is enabled for this
repository: open the Security tab and choose Report a vulnerability. If that
option is unavailable, contact the maintainer through the GitHub profile
without posting exploit details publicly. Include a concise description,
affected plugin and Harness versions,
operating system, Node.js version, reproduction steps, impact and any
available mitigations.

Please redact session ids, conversation text, uploaded file contents,
authentication material and absolute paths before attaching logs. Do not
publish a proof of concept that deletes or exposes another user's data.

## Scope

Security reports are especially important for:

- path traversal, symlink escapes or unsafe filesystem deletion;
- races between plugin operations and Host session writers;
- Trash/restore recovery that could overwrite or discard unrelated data;
- accidental deletion of shared attachments or workspace files;
- disclosure of conversation content through audit records or diagnostics.

The plugin deliberately fails closed when it cannot verify a persistence
location. A report that demonstrates a bypass of that boundary should include
the smallest safe reproduction possible.
