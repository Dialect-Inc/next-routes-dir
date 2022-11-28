import path from 'node:path'

import chokidar from 'chokidar'
import pDebounce from 'p-debounce'
import chalk from 'chalk'
import { generatePagesFromRoutes } from '~/utils/generate.js'

const debouncedGeneratePagesFromRoutes = pDebounce(
	() => generatePagesFromRoutes(),
	200
)

export async function setupRoutesDirectoryWatcher({ routesDir }: { routesDir: string }) {
	chokidar
		.watch(routesDir, { ignoreInitial: true })
		.on('add', async () => {
			await debouncedGeneratePagesFromRoutes()
			process.stderr.write(chalk.dim('Change in `routes/` detected, `/pages` regenerated\n'))
		})
		.on('change', async (filePath) => {
			if (
				filePath === path.join(routesDir, '_app.tsx') ||
				filePath === path.join(routesDir, '_document.tsx')
			) {
				process.stderr.write(
					chalk.dim(
						`Changes in ${path.basename(
							filePath
						)} detected, regenerating \`/pages\`...\n`
					)
				)
				await debouncedGeneratePagesFromRoutes()
			}
		})

	process.stderr.write('Generated `pages/` from `routes/`\n')
	await generatePagesFromRoutes()
}