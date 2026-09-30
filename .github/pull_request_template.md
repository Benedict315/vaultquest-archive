## Summary

-

## Linked Issue

-

## Release Readiness (complete for high-risk changes)

- [ ] Tests added or updated for the changed behavior
- [ ] Documentation updated (or explicitly not applicable)
- [ ] Migration safety preview run for new migrations (`migrationSafetyCli.ts` --preview)
- [ ] New env vars / contract IDs documented in `docs/environment.md`
- [ ] Rollback or forward-fix plan written below

- [ ] Automated check passes: `node --exports-map tsx scripts/releaseReadiness.ts --base origin/main`

## Rollback / Forward-Fix Plan

-

## Emergency Exception (only if a category cannot be satisfied)

- Categories not satisfied and why:
- Impact of shipping now vs. waiting:
- Follow-up PR/Issue that closes the gap:

## Validation

- [ ] `npm run lint`
- [ ] `npm run build`
- [ ] `pnpm audit` run for dependencies
- [ ] No raw secrets committed
- [ ] Additional contract/backend checks listed below when applicable

## UI Evidence

- [ ] Not applicable
- [ ] Screenshots attached
- [ ] Demo video/GIF attached

## Notes

- Include before/after screenshots where applicable for visible UI changes.
- Include a short demo video/GIF for interactive wallet or transaction flows.
- Document any new environment variables, contract IDs, or deployment steps introduced by this PR.
