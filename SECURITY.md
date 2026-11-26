# Security

## Reporting a vulnerability

Please report security problems privately through
[GitHub's private vulnerability reporting](https://github.com/aliasness-studio/Ntwine/security/advisories/new),
not in a public issue. If that link does not work for you, email
<aliasness.studio@proton.me> instead.

Include the Ntwine version, your operating system, and steps to reproduce. You should get a first
reply within a week.

## Supported versions

Only the latest release receives fixes. Ntwine updates itself, so the fix reaches you through the
normal update.

## What Ntwine touches

- It reads your Splice sample folder and the Splice app's `sounds.db`. It never writes to either.
- It writes only to its own application data folder.
- Network use is limited to downloading pack cover art during import and checking
  update.electronjs.org for new versions.
