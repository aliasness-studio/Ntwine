# Contributing

Bug reports are welcome: use the
[bug report form](https://github.com/aliasness-studio/Ntwine/issues/new/choose).

For a code change, please open an issue first so the approach can be agreed before you spend time
on it.

## Working on the code

Setup and commands are in the README under
[Building from source](README.md#building-from-source).

Before opening a pull request, run all four checks:

```bash
yarn e2e
yarn test
yarn typecheck
yarn lint
```

Run `yarn e2e` first on a fresh clone. It rebuilds the native SQLite module for Electron, and
`yarn test` fails without that. The same four checks run on macOS and Windows for every pull
request that changes more than documentation.

Changes to behavior need a test. Unit tests sit next to the code as `*.test.ts`; end-to-end tests
are in `tests/e2e/` and run against a synthetic library, so no Splice account is needed.
