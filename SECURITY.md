# Security Policy

fnmem treats executable memory as code, not inert data.

## Current threat model

A `MemoryFunction` runs with the same JavaScript privileges as the host process. fnmem v0.1 does **not** sandbox untrusted memory functions. Do not execute memory functions from untrusted sources.

Host applications should treat dynamically generated or downloaded memory functions as untrusted code unless they are reviewed, signed, sandboxed, or otherwise constrained by the host environment.

The runtime limits depth, visits, and total execution count to reduce accidental or adversarial unbounded activation loops, but those limits are not a security sandbox.

## Reporting

Please report security-sensitive issues privately through GitHub's security reporting features once enabled for the repository. Avoid publishing exploit details in a public issue before a fix is available.
