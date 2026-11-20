export const meta = { name: 'sens', description: 'Which paths count as sensitive for Write under a hook allow' }
const OUT = { type: 'object', properties: { results: { type: 'object' } }, required: ['results'] }
return await agent(`First call mcp__plugin_lessonshare_board__join with {"text":"x"}. Then, for each of these relative paths (make them absolute from your cwd), try to Write the file with content "x" exactly once and record "ok" or the exact error text. Do not retry and do not work around errors.
1. sens-test-plain/a.txt
2. .sens-test-dot/a.txt
3. .lessonshare/sens-test/a.txt
4. .lessonshare/runs/sens-test/writers/w01/work/a.txt
5. lessonshare-data/runs/sens-test/writers/w01/work/a.txt
6. .lessonshare/runs/sens-test/writers/w01/NOTES.md
7. sens-test-plain/NOTES.md
8. sens-test-plain/solution.js
Return results as an object keyed by the path.`, { agentType: 'lessonshare:writer', schema: OUT })
