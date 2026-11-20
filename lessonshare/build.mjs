import { build } from 'esbuild'
const entries = { board: 'src/mcp/board.ts', cli: 'src/cli/cli.ts', 'hook-stamp': 'src/hooks/stamp.ts', 'hook-guard': 'src/hooks/guard.ts' }
for (const [name, entry] of Object.entries(entries)) {
  await build({ entryPoints: [entry], outfile: `${process.env.LS_OUTDIR || 'dist'}/${name}.js`, bundle: true, platform: 'node', target: 'node20', format: 'cjs', legalComments: 'none', logLevel: 'warning' })
}
