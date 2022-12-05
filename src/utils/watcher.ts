import path from 'node:path'

import chalk from 'chalk'
import chokidar from 'chokidar'
import pDebounce from 'p-debounce'

import { type GenerateOptions } from '~/types/options.js'
import { generatePagesFromRoutes } from '~/utils/generate.js'

export async function setupRoutesDirectoryWatcher({
	routesDir,
	pagesDir,
	componentWrapperFunction,
}: GenerateOptions) {
	const debouncedGeneratePagesFromRoutes = pDebounce(
		async () =>
			generatePagesFromRoutes({
				routesDir,
				pagesDir,
				componentWrapperFunction,
			}),
		200
	)

	chokidar
		.watch(routesDir, { ignoreInitial: true })
		.on('add', async () => {
			await debouncedGeneratePagesFromRoutes()
			process.stderr.write(
				chalk.dim('Change in `routes/` detected, `/pages` regenerated\n')
			)
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
	await generatePagesFromRoutes({ pagesDir, routesDir })
}
