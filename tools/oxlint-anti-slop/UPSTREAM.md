# Vendored: anti-slop Oxlint plugin

Public origin: https://github.com/dmmulroy/anti-slop, distributed by the published
`install-anti-slop` skill as its bundled `assets/anti-slop` tree.

- Source revision: **unknown**. The skill bundle carries no commit or tag metadata,
  so no upstream revision is claimed here. Do not guess one.
- Retrieved: 2026-10-18 from the bundled `assets/anti-slop` directory of the
  `install-anti-slop` skill.
- License: MIT, Copyright (c) 2026 Dillon Mulroy. The full upstream license text is
  retained in `LICENSE` next to this file (upstream `LICENSE`, retrieved 2026-10-18
  from https://raw.githubusercontent.com/dmmulroy/anti-slop/main/LICENSE).
- Copied files: 26 TypeScript files, byte-identical to the bundle. The file bodies
  were not modified, reformatted, or lint-fixed.

## Pristine manifest

Canonical manifest: files sorted ordinally by forward-slash relative path; one line
per file, `<path><TAB><sha256 of file bytes, lowercase hex><LF>`; UTF-8 without BOM.
SHA-256 of the canonical manifest text:

    ab89fcc42088f6c2bf9952b24837ebe449e1c9c8374bc1b1c2da649232ea8502

Per-file SHA-256 in the same canonical order:

| path | sha256 |
| --- | --- |
| effect/index.ts | 18bd4a2d94aa0d657f3d93b49cd79efc6f3f453f6f47c35e89eb2b38dd209a3b |
| effect/rules/no-service-constructor-imports.ts | ee4380e0ae72a0ca28b2ac91967c4673bfaf45c987ceacc89402b59841b3b667 |
| index.ts | 78ae2d6a298c24a0c8367bbec2fae8189ab54a74f7e252a6f74b7df600d0e58d |
| rules/no-array-filter-map.ts | 1f900fb593c70c312626b7b3693983480a23183f0b6aa901af496112d0e0fd6e |
| rules/no-chained-type-assertions.ts | 74ad0ee01514cb4ce38e927fe233c7d3ba000acf053e03bda3432d1276c2957d |
| rules/no-conditional-empty-object-spread.ts | 2322467f4d48ef8983de9e2f322963a365ceb0539d6d82fe446e2a9d53d23f24 |
| rules/no-known-value-widening.ts | cf95829700f50d234bca57e537f3ff4276d7ddf0cb6b2ed315bba64b9985fb3d |
| rules/no-module-mocking.ts | 91db9f7ad64c2d3658702f6658c4284344b87240ae5956b89356ba458e029922 |
| rules/no-object-parameters.ts | c9be2966b5ceea5b1b603f8edea975f12840a8238cec4d2db4e490e0424081de |
| rules/no-reduce-accumulator-copy.ts | 08c7890157051c6f3678f6271bb526394776846eca7349294250e0de56eb1d05 |
| rules/no-reflect-apply.ts | 5b5e28158b70738c91cc17a18aa68dc4910628e5de64a7b4ae550344b379d9b9 |
| rules/no-reflect-get.ts | 07b2d268eefb30bc01b119f90d036ea5650fff7f82b5036b7b7a0227bb9239ee |
| rules/no-runtime-typeof.ts | a6d4ce9b49a5ac6f230db21ca11ac90405051842fb08af3c5843d70d7638bef1 |
| rules/no-shape-in-symbol-names.ts | 597c1700afb30872bca4e4c10fb84a3f0a1e1706e8ec395a60406f0fe784302e |
| rules/no-unknown-parameters.ts | 2ded9edd0c493fbefa1af7348d691055cb892ff99155ee83126431c36873bc80 |
| rules/no-unknown-returns.ts | 90c0dfbd0d24ae6453f34bb124cadfddc580a09cf7dbb25d8d4b0194330d8332 |
| rules/no-unknown-type-aliases.ts | d4b2571d017a92c9d4dea0472e7f535337dbde569381997d0350f1eea438dd22 |
| rules/no-unsafe-dictionary-type.ts | a67b131858343b806e7e910d49dd0fed8df9ea2050b7f304d994e4f378fee743 |
| rules/no-widen-then-assert.ts | 3e62fab0cd532522aa9f3cf01f49de15eae7422b7ffb65c93f60fa3231d8e3de |
| rules/require-safety-comment-for-type-assertion.ts | 5d31124163837b7974846c99f330c77e9cffc05e4367be8938235ce6459b225e |
| shared/array-method.ts | 309e489d8c99393bf07220ac50f8814208bcbc9a2119a3cf54a539cfe8fa2b5f |
| shared/dictionary-types.ts | cc7faee56bbfd5fc54ef24ebba697aaf52dc9de8c6cfd0720fa1ceacf9b7a955 |
| shared/function-parameters.ts | 2dfa4ac9c9f57708e44c1f7f2a609c0aa82f9bc50b6a7fa44e2c11f13a1da0c9 |
| shared/lexical-type-parameters.ts | c73cd979b710ed17c89b3ae484b2aedfbf5ccc74c29471539edb16c5753f256a |
| shared/reflect-method.ts | bd261bea42c7eba7285b847ca8d887e95e0d9975ba1ed3fc38ddb1fac21ca41b |
| shared/type-alias-resolution.ts | 6aaa0b3317326a7cb4f0bb13e0c62c8c3bf3423f1ad71d3cc810ffbd30ee625b |

## Deviations and build integration

- No file-body deviations. The plugin is compiled read-only by the repository's
  existing TypeScript 7 (`tsconfig.oxlint.json`) into the git-ignored
  `node_modules/.cache/oxlint-anti-slop/` output, and Oxlint loads the emitted ESM
  JavaScript through the `jsPlugins` alias in `oxlint.json`.
- The opt-in `effect/` rules are vendored but not registered: this repository has
  no direct `effect` dependency.
