## Summary

Describe the change and why it is needed.

## Linked Issue

Use `Fixes #...` or `Refs #...` when available.  
If no issue exists, include a short rationale/scope summary.

## OpenCode Validation

- Current production released OpenCode version tested:
- Why this version is relevant to the fix:

## Before-and-after evidence

Does this change affect the dashboard UI or human-readable output? If yes, attach matching before-and-after screenshots for each affected dashboard surface, using the same configuration, model/provider, theme, and window size.

For dashboard changes, report Quota, Analytics, and Settings. Identify unchanged or untested routes explicitly.

Redact credentials, account identifiers, private paths, and other sensitive information. For text-formatting changes, include the relevant output as well as screenshots.

Tests do not replace screenshot evidence.

If a route could not be tested, identify it and explain briefly. If there is no visible effect, write `Not applicable` and explain briefly.

Before:

After:

Route checks:

## Quality Checklist

- [ ] I ran `pnpm verify`
- [ ] This change is focused and avoids unrelated behavior changes
- [ ] I updated or added tests when behavior changed
- [ ] I updated docs when user-facing workflow, command, or config behavior changed
- [ ] For provider changes, I followed [Provider Changes](https://github.com/PVLPM/opencode-quota-gui/blob/main/CONTRIBUTING.md#provider-changes), or this does not apply
