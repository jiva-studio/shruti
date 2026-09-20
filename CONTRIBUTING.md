# Contributing

Lectorium is **source-available, not open source**. The code is published
under the [PolyForm Noncommercial License 1.0.0](./LICENSE) so it can be read,
studied and learned from. That shapes what contribution means here.

## What this project wants

Bug reports, reproductions and security findings are welcome and useful.
So are corrections to the documentation, which is written from the code and
drifts.

Pull requests are read, but slowly, and a large one that nobody asked for will
probably be declined — not because it is bad, but because this is one person's
project with a live backend behind it. **Open an issue before writing
anything substantial** so we can agree it is wanted.

## Licensing of contributions

By opening a pull request you agree that your contribution is licensed under
the same terms as the project, and that you have the right to license it.

Note that the license is noncommercial, which is not an OSI-approved open
source license. If you need different terms for your contribution, say so in
the pull request rather than assuming.

## Before you open a pull request

- One concern per pull request. A mixed diff is hard to review and harder to
  revert.
- The title follows [Conventional Commits](https://www.conventionalcommits.org)
  — CI enforces it, and release notes are generated from it.
- Tests pass: `go test ./...` in the service you touched, `npx vitest run` in
  `modules/apps/mobile`.
- No secrets, no host names, no IP addresses, no personal paths. A secret scan
  runs on every pull request and on the full history.

## Security

Do not report vulnerabilities through issues or pull requests. See
[SECURITY.md](./SECURITY.md).
