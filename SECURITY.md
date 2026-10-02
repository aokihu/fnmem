# Security Policy

fnmem treats executable memory as code, not inert data.

## Current threat model

DSL v0 has no imports, embedded code, authored loops or external side effects. Static validation precedes JavaScript generation; strings are encoded as literals. The artifact loader recompiles source and verifies code, hashes and versions before importing the generated module. This checks source/code consistency; it does not authenticate an author or provide an operating-system sandbox.

The legacy `MemoryFunction` callback interface runs with the same JavaScript privileges as the host process. fnmem v0.1 does **not** sandbox arbitrary native callbacks. Hosts must constrain or review callbacks from untrusted sources.

The runtime limits depth, visits, and total execution count to reduce accidental or adversarial unbounded activation loops, but those limits are not a security sandbox and cannot interrupt a native callback that never returns.

The MCP adapter loads a host-selected verified DSL bundle and exposes recall plus read-only resources; clients cannot register native callbacks or replace definitions. HTTP defaults to loopback, validates Host/Origin and supports an optional shared bearer token. Connected agents share definitions and Run resources; there is no per-agent access isolation. Remote deployment belongs behind trusted-network access or an authenticated TLS proxy. Local Run hashes detect corruption and do not authenticate someone with filesystem write access. See [MCP.md](./docs/MCP.md).

## Reporting

Please report security-sensitive issues privately through GitHub's security reporting features once enabled for the repository. Avoid publishing exploit details in a public issue before a fix is available.
