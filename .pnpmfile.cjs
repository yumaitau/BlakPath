/**
 * better-auth declares an optional vitest peer. When that peer is installed as
 * a devDependency, pnpm still counts it in the production graph, which drags
 * the test runner into `pnpm audit --prod`. Drop the peer so vitest stays dev-only.
 */
function readPackage(pkg) {
  if (pkg.name === 'better-auth') {
    if (pkg.peerDependencies) delete pkg.peerDependencies.vitest;
    if (pkg.peerDependenciesMeta) delete pkg.peerDependenciesMeta.vitest;
  }
  return pkg;
}

module.exports = {
  hooks: { readPackage },
};
