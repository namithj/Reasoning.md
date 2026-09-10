# Project regression checks

- For changes involving workspace or repository discovery, path canonicalization, containment, temporary directories, or host association, check Linux, macOS, and Windows behavior. Regression coverage must include macOS `/var` versus `/private/var` aliases and Windows short-name, long-name, and case aliases. Compare canonical or physical filesystem identity instead of raw path strings.
- When fixing a platform-specific failure, keep a regression test that exercises the underlying platform assumption so Linux-only runs cannot hide it.
