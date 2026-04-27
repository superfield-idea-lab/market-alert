export const config = {
  repoRoot: process.env.SUPERFIELD_REPO_ROOT ?? process.cwd(),
  port: Number(process.env.PORT) || 31415,
};
