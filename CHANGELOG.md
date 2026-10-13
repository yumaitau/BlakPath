# Changelog

Production releases are published by [`.github/workflows/cd.yml`](.github/workflows/cd.yml).
Each GitHub Release for a `vMAJOR.MINOR.PATCH` tag lists the commits since the
previous tag and the digest-pinned web and worker images that were deployed.
The tag points at the commit that was built. `package.json` is only the version
floor until the first tag exists. The pipeline does not commit a later version
bump, because that commit would not be the image that shipped.

## Unreleased

No production release has been tagged. The package version is `0.1.0`.
