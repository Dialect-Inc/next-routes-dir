import path from 'node:path'

import chalk from 'chalk'
import chokidar from 'chokidar'
import pDebounce from 'p-debounce'

import { type GenerateOptions } from '~/types/options.js'
import { RouteFile, RouteGenerator } from '~/utils/generate.js'

export async function setupRoutesDirectoryWatcher(options: GenerateOptions) {
	const routeGenerator = new RouteGenerator(options)
	const debouncedGeneratePagesFromRoutes = pDebounce(
		async () => routeGenerator.generatePagesDirectory(),
		200
	)

	chokidar
		.watch(options.routesDir, { ignoreInitial: true })
		.on('add', async () => {
			await debouncedGeneratePagesFromRoutes()
			process.stderr.write(
				chalk.dim('Change in `routes/` detected, `/pages` regenerated\n')
			)
		})
		.on('delete', async () => {
			await debouncedGeneratePagesFromRoutes()
			process.stderr.write(
				chalk.dim('Change in `routes/` detected, `/pages` regenerated\n')
			)
		})
		// When a specific file is changed
		.on('change', async (filePath) => {
			// If the file path is a layout file, it might affect other files, so we regenerate the whole `pages/` directory (but this could be optimized)
			if (path.parse(filePath).name === 'layout') {
				await debouncedGeneratePagesFromRoutes()
			}
			// Otherwise, only update the pages/ file for the specific file which was changed
			else {
				const routeFile = new RouteFile({ filePath, routeGenerator })
				await routeFile.generateTargetPagesFile()
			}
		})

	await routeGenerator.generatePagesDirectory()
	process.stderr.write('Generated `pages/` from `routes/`\n')
}
