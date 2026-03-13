export const config = {
  repoRoot: process.env.CALYPSO_REPO_ROOT ?? process.cwd(),
  port: Number(process.env.PORT) || 31415,
};
